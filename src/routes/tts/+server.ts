import { tts } from '$lib/server/util/tts';
import type { RequestHandler } from './$types';

async function runTTS() {
    const ttsResp = await tts({
        segments: [{
            text: 'one',
            minDurationSec: 2
        },
        {
            text: 'two',
            minDurationSec: 2
        },
        {
            text: 'three',
            minDurationSec: 2
        }]
    });
    return ttsResp.audio;
}

export const GET = (async () => {
    return new Response(await runTTS(), { 'headers': { 'Content-Type': 'audio/mpeg' } });
}) satisfies RequestHandler;
