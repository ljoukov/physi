import { callbackToResponse, generatorToResponse } from '$lib/server/util/generators';
import { sleepSec } from '$lib/server/util/timer';
import type { RequestHandler } from './$types';

async function process(log: (msg: string) => void) {
    for (let i = 0; i < 10; i++) {
        await sleepSec(1);
        log(`i=${i}`);
    }
}

export const POST: RequestHandler = async () => {
    const messages: (string | null)[] = [];
    let notify: () => void = () => { };
    const p = process((msg: string) => {
        messages.push(msg);
        notify();
    });
    p.then(() => { messages.push(null) });
    const cb = async (): Promise<string | null> => {
        while (messages.length === 0) {
            await new Promise((r) => notify = () => { r(null); });
        }
        return messages.shift()!;
    };
    return callbackToResponse(cb);
};
