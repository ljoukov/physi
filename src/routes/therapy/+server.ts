import { generatorToResponse } from '$lib/server/util/generators';
import { sleepSec } from '$lib/server/util/timer';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
    const logsGen = async function* () {
        yield 'hi, loading audio file\n\n';
        for (let i = 0; i < 10; i++) {
            await sleepSec(1);
            yield `i=${i}\n\n`;
        }
        return;
    };
    return generatorToResponse(logsGen());
};
