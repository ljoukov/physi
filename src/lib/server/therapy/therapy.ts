import { z } from "zod";
import { sleepSec } from "../util/timer";

export const therapyInputSchema = z.object({ userInput: z.string() });
export type TherapyInput = z.infer<typeof therapyInputSchema>;

export async function generateTherapy({ userInput }: TherapyInput, log: (msg: string) => void) {
    log(`Generating therapy for userInput: ${userInput}`);
    for (let i = 0; i < 10; i++) {
        await sleepSec(1);
        log(`i=${i}`);
    }
}
