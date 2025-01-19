import { z } from "zod";
import { concatAudio, createSilentAudio, getAudioDetails, type AudioDetails } from "./ffmpeg";
import { newTimer } from "./timer";
import { getGoogleAccessToken } from "./gcpToken";
import { deleteTempFile, getTempFilePath, readUint8ArrayFromTempFile, writeUint8ArrayToTempFile } from "./file";
import { SlidingWindowRateLimiter } from "./rateLimitter";
import { errorAsString } from "$lib/util/error";

export type TranscriptSegment = {
    text: string;
    minDurationSec?: number;
    leadingPauseSec?: number;
};

export type Transcript = {
    segments: TranscriptSegment[]
};

export async function tts(
    ttsRequest: Transcript,
): Promise<{
    audio: Uint8Array
    audioDetails: AudioDetails
}> {
    if (ttsRequest.segments.length === 0) {
        throw Error('handleTTS: no input segments');
    }
    if (ttsRequest.segments[0].leadingPauseSec) {
        throw Error('handleTTS: non-zero leading silence for the first segment');
    }
    const timer = newTimer();
    const segmentPromisses: Promise<{
        speechFileName: string;
        audioDetails: AudioDetails;
    }>[] = [];
    const numSegments = ttsRequest.segments.length;
    const timestampStr = new Date()
        .toISOString()
        .replaceAll(':', '')
        .replaceAll('-', '')
        .replaceAll('.', '');
    const filesToDelete: string[] = [];
    try {
        // TTS and transcribe each segment
        for (const [segmentIndex, segment] of ttsRequest.segments.entries()) {
            const segmentPromise = (async () => {
                for (let i = 0; ; i++) {
                    try {
                        const encodedAudio = await ttsSegment({
                            voice: 'female',
                            text: segment.text
                        });
                        const speechFileName = `handleTTS-${timestampStr}-speech-${segmentIndex.toString().padStart(5, '0')}-of-${numSegments.toString().padStart(5, '0')}.mp3`;
                        await writeUint8ArrayToTempFile(encodedAudio, speechFileName);
                        filesToDelete.push(speechFileName);
                        const audioDetails = await getAudioDetails(getTempFilePath(speechFileName));
                        return { speechFileName, audioDetails };
                    } catch (e) {
                        if (i >= 10) {
                            console.error(`ttsSegment FAILED: ${errorAsString(e)}`);
                            throw e;
                        }
                        console.info(`ttsSegment[${i}] failed, ignoring: ${errorAsString(e)}`);
                    }
                }
            })();
            segmentPromisses.push(segmentPromise);
        }

        let ttsAudioDetails: undefined | { sampleRate: number; channels: 1 | 2 };

        // create pauses
        const filesToJoin: string[] = [];
        for (const [segmentIndex, segmentPromise] of segmentPromisses.entries()) {
            const { speechFileName, audioDetails } = await segmentPromise;
            const { sampleRate, durationSec, channels } = audioDetails;
            if (!ttsAudioDetails) {
                ttsAudioDetails = { sampleRate, channels };
            }
            const leadingSilenceSec =
                segmentIndex === 0
                    ? 0
                    : ttsRequest.segments[segmentIndex].leadingPauseSec
                        ? ttsRequest.segments[segmentIndex].leadingPauseSec
                        : 0.25/*ttsRequest.silenceSec*/;
            if (leadingSilenceSec > 0) {
                const leadingSilenceFileName = `handleTTS-${timestampStr}-leading-silence-${segmentIndex.toString().padStart(5, '0')}-of-${numSegments.toString().padStart(5, '0')}.mp3`;
                await createSilentAudio({
                    sampleRate,
                    channels,
                    durationSec: leadingSilenceSec,
                    fileName: getTempFilePath(leadingSilenceFileName)
                });
                filesToJoin.push(leadingSilenceFileName);
                filesToDelete.push(leadingSilenceFileName);
            }

            filesToJoin.push(speechFileName);
            const speechDurationSec = audioDetails.durationSec;

            const { minDurationSec } = ttsRequest.segments[segmentIndex];
            const trailingSilenceSec =
                minDurationSec !== undefined && minDurationSec > speechDurationSec
                    ? minDurationSec - speechDurationSec
                    : 0;
            if (trailingSilenceSec > 0) {
                const trailingSilenceFileName = `handleTTS-${timestampStr}-trailing-silence-${segmentIndex.toString().padStart(5, '0')}-of-${numSegments.toString().padStart(5, '0')}.mp3`;
                await createSilentAudio({
                    sampleRate,
                    channels,
                    durationSec: trailingSilenceSec,
                    fileName: getTempFilePath(trailingSilenceFileName)
                });
                filesToJoin.push(trailingSilenceFileName);
                filesToDelete.push(trailingSilenceFileName);
            }
        }

        // List of files to join
        const listFileName = `handleTTS-${timestampStr}-list.txt`;
        const fileListContent = filesToJoin.map((n) => `file '${getTempFilePath(n)}'`).join('\n');
        await writeUint8ArrayToTempFile(new TextEncoder().encode(fileListContent), listFileName);
        filesToDelete.push(listFileName);

        if (!ttsAudioDetails) {
            throw Error('handlerTTS: faailed to determine ttsAudioDetails');
        }

        // Concatenate
        const joinedFileName = `handleTTS-${timestampStr}-joined.mp3`;
        await concatAudio({
            listFileName: getTempFilePath(listFileName),
            outputFileName: getTempFilePath(joinedFileName),
            sampleRate: ttsAudioDetails.sampleRate,
            channels: ttsAudioDetails.channels
        });
        const audioDetails = await getAudioDetails(getTempFilePath(joinedFileName));
        const audio = await readUint8ArrayFromTempFile(joinedFileName);

        console.log(JSON.stringify(audioDetails, null, 2));
        return {
            audio,
            audioDetails
        };
    } finally {
        for (const fileName of filesToDelete) {
            try {
                await deleteTempFile(fileName);
            } catch (e) {
                console.warn(`handleTTS: failed to delete temp file ${fileName}`);
            }
        }
    }
}

async function getAuthToken(): Promise<string> {
    const accessToken = await getGoogleAccessToken({
        scopes: [
            'https://www.googleapis.com/auth/cloud-platform'
        ],
        audiences: ['https://accounts.google.com/o/oauth2/token']
    });
    return accessToken.token;
}

const googleTtsResponseSchema = z.object({
    audioContent: z.string(),
    audioConfig: z.object({
        audioEncoding: z.enum(['MP3']),
        sampleRateHertz: z.number(),
    })
});

export type TTSVoice = 'male' | 'female';

const ttsRateLimiter1 = new SlidingWindowRateLimiter({
    maxQPW: 10,
    windowSec: 10,
    label: 'tts1'
});

const ttsRateLimiter2 = new SlidingWindowRateLimiter({
    maxQPW: 40,
    windowSec: 60,
    label: 'tts2'
});

export async function ttsSegment({ text, voice }: { text: string; voice: TTSVoice }): Promise<Uint8Array> {
    await ttsRateLimiter1.waitForAvailability();
    await ttsRateLimiter2.waitForAvailability();
    const name: 'en-US-Journey-F' | 'en-US-Journey-D' = (() => {
        switch (voice) {
            case 'male':
                return 'en-US-Journey-D';
            case 'female':
                return 'en-US-Journey-F';
        }
    })();
    const req = {
        input: {
            text
        },
        voice: {
            languageCode: "en-US",
            name
        },
        audioConfig: {
            audioEncoding: "MP3"
        }
    };
    const fetchResp = await fetch(
        'https://texttospeech.googleapis.com/v1beta1/text:synthesize',
        {
            headers: {
                'Authorization': `Bearer ${await getAuthToken()}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            method: 'POST',
            body: JSON.stringify(req)
        }
    );
    const json = await fetchResp.json();
    try {
        const resp = googleTtsResponseSchema.parse(json);
        return new Uint8Array(Buffer.from(resp.audioContent, 'base64'));
    } catch (e) {
        throw Error(`Failed to parse google TTS response: ${JSON.stringify(json, null, 2)}: ${errorAsString(e)}`);
    }
}
