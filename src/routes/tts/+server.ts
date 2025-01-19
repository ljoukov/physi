import { getGoogleAccessToken } from '$lib/util/gcpToken';
import { z } from 'zod';
import type { RequestHandler } from './$types';

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

async function tts({ text, voice }: { text: string; voice: TTSVoice }) {
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
    const resp = googleTtsResponseSchema.parse(await fetchResp.json());
    return Buffer.from(resp.audioContent, 'base64');
}

export const GET = (async () => {
    return new Response(await tts({ text: 'here is your routine', voice: 'male' }), { 'headers': { 'Content-Type': 'audio/mpeg' } });
}) satisfies RequestHandler;

