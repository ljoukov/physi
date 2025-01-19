import { callbackToResponse, generatorToResponse } from '$lib/server/util/generators';
import { sleepSec } from '$lib/server/util/timer';
import { z } from 'zod';
import type { RequestHandler } from './$types';

const therapyInputSchema = z.object({ userInput: z.string() });
type TherapyInput = z.infer<typeof therapyInputSchema>;

async function process({ userInput }: TherapyInput, log: (msg: string) => void) {
    log(`userInput: ${userInput}`);
    for (let i = 0; i < 10; i++) {
        await sleepSec(1);
        log(`i=${i}`);
    }
}


export const POST: RequestHandler = async ({ request }) => {
    const therapyInput = therapyInputSchema.parse(await request.json());
    const messages: (string | null)[] = [];
    let notify: () => void = () => { };
    const log = (msg: string) => {
        messages.push(msg);
        notify();
    };
    const p = process(therapyInput, log);
    p.then(() => { messages.push(null) });
    const cb = async (): Promise<string | null> => {
        while (messages.length === 0) {
            await new Promise((r) => notify = () => { r(null); });
        }
        return messages.shift()!;
    };
    return callbackToResponse(cb);
};
