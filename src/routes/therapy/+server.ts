import { callbackToResponse } from '$lib/server/util/generators';
import type { RequestHandler } from './$types';
import { generateTherapy, therapyInputSchema } from '$lib/server/therapy/therapy';
import { errorAsString } from '$lib/util/error';

export const POST: RequestHandler = async ({ request }) => {
    const therapyInput = therapyInputSchema.parse(await request.json());
    const messages: (string | null)[] = [];
    let notify: () => void = () => { };
    const log = (msg: string) => {
        messages.push(msg);
        notify();
    };
    const p = generateTherapy(therapyInput, log);
    p
        .then(() => { messages.push(null) })
        .catch((e) => {
            messages.push(`Error: ${errorAsString(e)}`);
            messages.push(null);
        });
    const cb = async (): Promise<string | null> => {
        while (messages.length === 0) {
            await new Promise((r) => notify = () => { r(null); });
        }
        return messages.shift()!;
    };
    return callbackToResponse(cb);
};
