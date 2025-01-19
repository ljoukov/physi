import { z } from "zod";
import { llmCompletion, llmTextStream, type LLMCompletionRequest } from "../util/llm";
import { parseKeyValueDelta, SEPARATOR } from "../util/delta_parser";
import { tts, ttsSegment, type Transcript } from "../util/tts";
import { getTempFilePath, writeUint8ArrayToTempFile } from "../util/file";
import { base64encode } from "$lib/util/base64";

export const therapyInputSchema = z.object({ userInput: z.string() });
export type TherapyInput = z.infer<typeof therapyInputSchema>;

async function generatePlan({ userInput }: TherapyInput, log: (msg: string) => void): Promise<Plan> {
    log('Generating plan');
    const llmRequest: LLMCompletionRequest = {
        model: 'gemini-2.0-flash-exp',
        max_tokens: 4096,
        messages: [
            {
                role: 'user', content: `\
You are an expert physiotherapist. \
You create guided exercises for the user. \
User reports the physio problem and you create a plan for a short 1 minute session to improve. \
Assume the user has no access to wall or any equipment, the user is standing.

<USER_INPUT>
${userInput.replaceAll('\n', ' ')}
</USER_INPUT>

<OUTPUT_FORMAT>
$IDEAS:
- internal scratch space to brainstorm ideas for new interesting creative exercises for the user
- concise and creative
$REASONING:
[internal scratch space to reason through the problem, very concise, realize the setting, privacy requirements, user goals and health restrictions, check for IDEAS for the main exercise sequence, warmup and cooldown]
$WARMUP: [title, 3-4 words]
- Clear instructions
- Detailed breakdown with exact number of repetitions (usually between 2 and 3 repetitions; always less than 5 repetitions)
- aim for 15 seconds
$EXERCISE: [title, 3-4 words]
- usually 1 minute
$COOL_DOWN: [title, 3-4 words]
- approximately 15 seconds
$SESSION_TITLE: [title which best encompasses this whole exercise session, 3-4 words, don't put duration into the title]
</OUTPUT_FORMAT>
`}],
    }
    let planStr = '';
    for await (const delta of llmTextStream(llmRequest)) {
        planStr += delta;
        log(JSON.stringify({ text: delta }));
    }
    log('----');
    log(JSON.stringify({ text: planStr }));
    log('----');
    const plan = parsePlan(planStr);
    log(JSON.stringify(plan));
    return plan;
}

type Plan = {
    title: string;
    reasoning: string;
    warmup: string;
    exercise: string;
    cooldown: string;
};

export function parsePlan(llmOutput: string): Plan {
    const startIndex = llmOutput.indexOf('$IDEAS:');
    if (startIndex === -1) {
        throw Error('$IDEAS: is not present in raw exercise plan.');
    }
    const strippedRawText = llmOutput.substring(startIndex);
    const plan: Plan = {
        title: '',
        reasoning: '',
        warmup: '',
        exercise: '',
        cooldown: '',
    };
    for (const delta of parseKeyValueDelta(strippedRawText)) {
        switch (delta.type) {
            case 'incomplete_kv':
            case 'kv': // fall-through
                switch (delta.key) {
                    case 'REASONING':
                        plan.reasoning = delta.value;
                        break;
                    case 'SESSION_TITLE':
                        plan.title = delta.value;
                        break;
                    case 'WARMUP':
                        plan.warmup = delta.value;
                        break;
                    case 'EXERCISE':
                        plan.exercise = delta.value;
                        break;
                    case 'COOL_DOWN':
                        plan.cooldown = delta.value;
                        break;
                }
                break;
            case 'separator': // fallthrough
            case 'remaining':
                break;
        }
    }
    return plan;
}

async function generateTranscript(plan: Plan, log: (msg: string) => void): Promise<Transcript> {
    log('Generating transcript');
    /*
    <COOL_DOWN_PLAN>
    ${plan.cooldown}
    </COOL_DOWN_PLAN>
    */
    const llmRequest: LLMCompletionRequest = {
        model: 'gemini-exp-1206',
        max_tokens: 4096,
        messages: [
            {
                role: 'user', content: `\
You are an expert physiotherapist. \
You create guided exercises for the user. \
User reports the physio problem and you create a plan for a short 1 minute session to improve. \
Assume the user has no access to wall or any equipment, the user is standing.

Please help create complete transcript of the exercise session '${plan.title}' following the plan:
<WARMUP_PLAN>
${plan.warmup}
</WARMUP_PLAN>
<EXERCISE_PLAN>
${plan.exercise}
</EXERCISE_PLAN>

Go through each required repetition explicitly in a natural way.

Produce output in the following format:
<OUTPUT_FORMAT>
$TITLE: [text to be displayed for the user, 3-4 words]
$SECTION: warmup
$VOICE: [instructor's speech]
$REPS_START: [total repetitions] marks the beginning of repetitions sequence
$REP: [current repetition] / [total repetitions] this starts the repetition
$VOICE: [general speech or explanation of the timed instruction which follows]
$VOICE_[sec]: [instruction which should be precisely timed to be duration "sec", eg for each count when counting or breathing instructions]
$PAUSE: [sec] use to enforce short pause, eg just after explanation before VOICE_[sec] timed instructions, normally PAUSE is not needed after VOICE_[sec]
...
$REPS_END: [total repetitions] marks the end of repetitions sequence
...

$SECTION: exercise
...

</OUTPUT_FORMAT>

IMPORTANT:
- timed counting like "one", "two", "three" should each be a separate timed VOICE_[sec] commands. Depending on the complexity of the movement consider 1 second, 2 or even 3 seconds per count.
- Do NOT use long times in VOICE_[sec], sec should be between 1 and 5. Produce multiple VOICE_[sec] commands if necessary.
- Use PAUSE to correctly pace the exercise, don't use pauses longer than 5 seconds, you can use fractional pauses like 0.75 if suitable
- in VOICE and VOICE_[sec] use extensive punctuation, including "..." to signal a pause
- Clearly explain (i.e. just from text in VOICE and VOICE_[sec]) when instruction is being described and when the user should follow the instruction (timed instructions start)
- a lot of users would not look at the screen to see text in TITLE, so make VOICE and VOICE_[sec] self sufficient
- if PLAN requires you can use multiple REPS_START/REPS_END blocks, eg separate block for each side, for forward and backward, limit to 5 repetitions in a single block
- when choosing wording remember that this is the first but not last part of the overall transcript, you can mention the exercise title, and welcome the user
- use multiple VOICE tags to separate sentences, especially when explaining the movement to be done, this makes it easier to listen
- use natural instructions, avoid repetition

When using VOICE_sec tags:
GOOD EXAMPLES:
$VOICE_1: ...three...
$VOICE_1: ...two...
$VOICE_1: ...one...
$VOICE_1: ...exhale...

Do NOT put mutiple counts into a single VOICE_sec tag as TTS system will not get the timing right:
BAD EXAMPLEs:
$VOICE_1: Inhale... two... three... four.
$VOICE_1: Inhale [for single word commands use lower case and all ... before and after, eg "...inhale..."]
$VOICE_4: 4... 3... 2... 1...
$VOICE_2: One... Two...
$VOICE_4: [non-instruction; instead use $VOICE]
$VOICE_3: I am calm, focused, and ready for the day. [this is too long, use $VOICE and $PAUSE]
$VOICE: [multiple sentences; instead use multiple $VOICE tags and potentially $PAUSE after each]

REMEMBER: output explicitly entire sequence, do NOT output anything like "[Similar sequence repeats]".

CRITICALLY IMPORTANT: output entire transcript, do NOT abbreviate like "$VOICE_30: [30 seconds of silent shoulder blade squeezes]"

IMPORTANT REMEMBER: always make no more than 5 repetitions and no more than five counts(!)

Never output repetitative sequences like:
$VOICE_1: ...shake...
$VOICE_1: ...shake...
$VOICE_1: ...shake...
....

Start your output with $TITLE:
`}],
    }
    let transcriptStr = '';
    for await (const delta of llmTextStream(llmRequest)) {
        transcriptStr += delta;
        log(JSON.stringify({ text: delta }));
    }
    log('----');
    log(JSON.stringify({ text: transcriptStr }));
    const transcript = parseTranscript(transcriptStr);
    log(JSON.stringify(transcript));
    return transcript;
}

const voiceSecKeyRegexp = /^VOICE_(\d+)$/;
const repsCounterRegexp = /^(\d+)\s*\/\s*(\d+)$/;

export function parseTranscript(llmOutput: string): Transcript {
    const startIndex = llmOutput.indexOf('$TITLE:');
    if (startIndex === -1) {
        throw Error('$TITLE: is not present in exercise transcript.');
    }
    const strippedRawText = llmOutput.substring(startIndex);
    const transcript: Transcript = {
        segments: []
    };
    let pauseSec = 0;
    for (const delta of parseKeyValueDelta(strippedRawText + `\n${SEPARATOR}`)) {
        switch (delta.type) {
            case 'incomplete_kv':
                continue;
            case 'kv':
                // Process VOICE_[sec]: ... tag
                const voiceSecMatch = voiceSecKeyRegexp.exec(delta.key);
                if (voiceSecMatch !== null) {
                    const durationSec = parseInt(voiceSecMatch[1], 10);
                    transcript.segments.push({
                        text: delta.value,
                        minDurationSec: durationSec,
                        leadingPauseSec: pauseSec > 0 ? pauseSec : undefined
                    });
                    pauseSec = 0;
                    continue;
                }
                switch (delta.key) {
                    case 'VOICE':
                        transcript.segments.push({
                            text: delta.value,
                            leadingPauseSec: pauseSec > 0 ? pauseSec : undefined
                        });
                        pauseSec = 0;
                        break;
                    case 'PAUSE':
                        pauseSec = parseInt(delta.value, 10);
                        break;
                    case 'REPS_START':
                        {
                            const repTotal = parseInt(delta.value);
                        }
                        break;
                    case 'REPS_END':
                        {
                            const repTotal = parseInt(delta.value);
                        }
                        break;
                    case 'REP':
                        {
                            const match = repsCounterRegexp.exec(delta.value);
                            if (match === null) {
                                throw Error(`Invalid reps counter format: ${delta.value}`);
                            }
                            const repNumber = parseInt(match[1]);
                            const repTotal = parseInt(match[2]);
                        }
                        break;
                }
                break;
            case 'separator': // fallthrough
            case 'remaining':
                break;
        }
    }
    return transcript;
}

export async function generateTherapy(therapyInput: TherapyInput, log: (msg: string) => void) {
    log(`Generating therapy for userInput: ${therapyInput.userInput}`);

    const plan = await generatePlan(therapyInput, log);
    const transcript = await generateTranscript(plan, log);
    //    transcript.segments = transcript.segments.slice(0, 25);
    const { audio, audioDetails } = await tts(transcript);
    log(JSON.stringify({ audioDetails }));
    const audioBase64 = Buffer.from(audio).toString('base64');
    log(JSON.stringify({ audio: audioBase64 }));
}

const transcriptDebug: Transcript = {
    "segments": [
        {
            "text": "Welcome to this short session focused on relieving tennis arm."
        },
        {
            "text": "We'll start with a gentle warm-up."
        },
        {
            "text": "Let's begin with some gentle arm swings."
        },
        {
            "text": "We are going to swing arms forward and backward gently."
        },
        {
            "text": "Keep your movements slow and controlled."
        },
        {
            "text": "Now, gently swing your arms forward..."
        },
        {
            "text": "...one...",
            "minDurationSec": 1,
            "leadingPauseSec": 1
        },
        {
            "text": "...two...",
            "minDurationSec": 1
        },
        {
            "text": "...three...",
            "minDurationSec": 1
        },
        {
            "text": "...and backward."
        },
        {
            "text": "...one...",
            "minDurationSec": 1,
            "leadingPauseSec": 1
        },
        {
            "text": "...two...",
            "minDurationSec": 1
        },
        {
            "text": "...three...",
            "minDurationSec": 1
        },
        {
            "text": "Forward again..."
        },
        {
            "text": "...one...",
            "minDurationSec": 1,
            "leadingPauseSec": 1
        },
        {
            "text": "...two...",
            "minDurationSec": 1
        },
        {
            "text": "...three...",
            "minDurationSec": 1
        },
        {
            "text": "...and backward."
        },
        {
            "text": "...one...",
            "minDurationSec": 1,
            "leadingPauseSec": 1
        },
        {
            "text": "...two...",
            "minDurationSec": 1
        },
        {
            "text": "...three...",
            "minDurationSec": 1
        },
        {
            "text": "One last time, forward..."
        },
    ]
};