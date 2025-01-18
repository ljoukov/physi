import {
    GOOGLE_API_KEY,
} from '$env/static/private';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { type Json } from './json';
import { errorAsString, responseErrorAsString } from './error';
import { getGoogleAccessToken } from './gcpToken';
import { createParser, type ServerSourceEvent } from './eventsource-parser';

const googleModels = [
    'gemini-2.0-flash-exp',
    'gemini-1.5-pro-002',
    'gemini-1.5-flash-002',
    'gemini-exp-1206'
] as const;

export type GoogleLLMModel = (typeof googleModels)[number];

export type LlmCompletionDeltaParser = {
    feed(delta: string, controller: TransformStreamDefaultController<Uint8Array>): Promise<void>;
    done(controller: TransformStreamDefaultController<Uint8Array>): Promise<void>;
};

export const llmCompletionSchema = z.object({
    created: z.number(),
    choices: z
        .array(
            z.object({
                index: z.literal(0),
                message: z.object({
                    role: z.literal('assistant'),
                    content: z.string().optional()
                }),
                finish_reason: z
                    .enum(['stop', 'length', 'function_call', 'content_filter'])
                    .nullable()
                    .optional()
            })
        )
        .length(1) /* always length 1 */
});

export type LLMCompletion = z.infer<typeof llmCompletionSchema>;

const llmMessageSchema = z.object({
    role: z.enum(['system', 'assistant', 'user']),
    content: z.string()
});

export type LLMMessage = z.infer<typeof llmMessageSchema>;

export type LLMPromptMessage = Omit<LLMMessage, 'role'> & {
    role: Exclude<LLMMessage['role'], 'assistant'>;
};

export const llmModels = [
    ...googleModels,
] as const;

export const llmModelSchema = z.enum(llmModels);

export type LLMModel = z.infer<typeof llmModelSchema>;

export type LLMCompletionRequest = {
    model: LLMModel;
    messages: LLMMessage[];
    max_tokens: number;
    n?: number;
    temperature?: number;
};

async function llmFetch(request: {
    url: URL;
    headers: Record<string, string>;
    requestBody: Json;
}): Promise<Response & { body: ReadableStream<Uint8Array> }> {
    const fetchResponse = await fetch(request.url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...request.headers
        },
        body: JSON.stringify(request.requestBody)
    });
    if (!fetchResponse.ok) {
        const errorText = await responseErrorAsString(fetchResponse);
        console.log(errorText, '\nREQUEST:', JSON.stringify(request.requestBody, null, 2));
        throw error(500, errorText);
    }
    if (!fetchResponse.body) {
        const errorText = 'LLM returned empty body';
        console.log(errorText);
        throw error(500, errorText);
    }
    return fetchResponse as Response & { body: ReadableStream<Uint8Array> };
}

export type LLMDelta = {
    index: number;
    content?: string;
    isLast?: boolean;
};

export type LLMUsage = {
    responseModel?: string;
    promptTokens?: number;
    completionTokens?: number;
};

type LLMApiConfig = {
    url: URL;
    headers: Record<string, string>;
    requestBody: Json;
    parseDelta: (delta: string, usage: LLMUsage) => LLMDelta;
};

function getBearerHeaders(token: string): Record<string, string> {
    return {
        Authorization: `Bearer ${token}`
    };
}

const googleContentPartsSchema = z.array(
    z.object({
        text: z.string()
    })
);

const googleContentSchema = z.object({
    role: z.enum(['user', 'model']).optional(),
    parts: googleContentPartsSchema
});

const googleSystemInstructionSchema = z.object({
    parts: googleContentPartsSchema
});

export type GoogleSystemInstruction = z.infer<typeof googleSystemInstructionSchema>;
export type GoogleLlmMessage = z.infer<typeof googleContentSchema>;

// https://ai.google.dev/api/generate-content#generationconfig
const googleLlmRequestSchema = z.object({
    contents: z.array(googleContentSchema),
    generationConfig: z.object({
        stopSequences: z.array(z.string()).optional(),
        candidateCount: z.number().int().min(1).optional(),
        maxOutputTokens: z.number().int().min(1),
        temperature: z.number().min(0).max(2).optional(),
        topP: z.number().int().min(0).optional()
    }),
    safetySettings: z.array(
        z.object({
            category: z.enum([
                'HARM_CATEGORY_HATE_SPEECH',
                'HARM_CATEGORY_DANGEROUS_CONTENT',
                'HARM_CATEGORY_SEXUALLY_EXPLICIT',
                'HARM_CATEGORY_HARASSMENT'
            ]),
            threshold: z.enum([
                'BLOCK_NONE',
                'BLOCK_ONLY_HIGH',
                'BLOCK_MEDIUM_AND_ABOVE',
                'BLOCK_LOW_AND_ABOVE'
            ])
        })
    ),
    systemInstruction: googleSystemInstructionSchema.optional()
});

export type GoogleLlmRequest = z.infer<typeof googleLlmRequestSchema>;

async function getVertexAuthToken(): Promise<string> {
    const accessToken = await getGoogleAccessToken({
        scopes: [
            'https://www.googleapis.com/auth/generative-language',
            'https://www.googleapis.com/auth/cloud-platform'
        ],
        audiences: ['https://accounts.google.com/o/oauth2/token']
    });
    return accessToken.token;
}

function getGoogleLlmRequestBody(
    llmRequest: LLMCompletionRequest & { model: GoogleLLMModel },
) {
    const requestSystemInstruction: GoogleSystemInstruction | undefined =
        llmRequest.messages[0].role === 'system'
            ? { parts: [{ text: llmRequest.messages[0].content }] }
            : undefined;
    const requestNonSystemMessages: GoogleLlmMessage[] = llmRequest.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
        }));
    const { systemInstruction, contents } = ((): {
        systemInstruction: GoogleSystemInstruction | undefined;
        contents: GoogleLlmMessage[];
    } => {
        if (requestNonSystemMessages.length > 0) {
            return { systemInstruction: requestSystemInstruction, contents: requestNonSystemMessages };
        } else if (requestSystemInstruction !== undefined) {
            return {
                systemInstruction: undefined,
                contents: [{ role: 'user', ...requestSystemInstruction }]
            };
        } else {
            return { systemInstruction: undefined, contents: [] };
        }
    })();
    const threshold: GoogleLlmRequest['safetySettings'][number]['threshold'] = 'BLOCK_NONE';
    const requestBody: GoogleLlmRequest = {
        contents,
        generationConfig: {
            maxOutputTokens: llmRequest.max_tokens,
            ...(llmRequest.temperature ? { temperature: llmRequest.temperature } : {})
        },
        safetySettings: [
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold },
            { category: 'HARM_CATEGORY_HARASSMENT', threshold }
        ],
        ...(systemInstruction !== undefined ? { systemInstruction } : {})
    };
    return requestBody;
}

async function googleLlmApiConfig(
    llmRequest: LLMCompletionRequest & { model: GoogleLLMModel }
): Promise<LLMApiConfig> {
    const { model, version }: { model: GoogleLLMModel; version: 'v1' | 'v1beta' } = (() => {
        const { model } = llmRequest;
        switch (model) {
            case 'gemini-1.5-pro-002':
                return { model, version: 'v1' };
            case 'gemini-1.5-flash-002':
                return { model, version: 'v1' };
            case 'gemini-exp-1206':
                return { model, version: 'v1beta' };
            case 'gemini-2.0-flash-exp':
                return { model, version: 'v1beta' };
        }
    })();
    const url = new URL(
        `https://generativelanguage.googleapis.com/${version}/models/${model}:streamGenerateContent?alt=sse`
    );
    return {
        url,
        headers: { 'X-goog-api-key': GOOGLE_API_KEY },
        requestBody: getGoogleLlmRequestBody(llmRequest),
        parseDelta: parseGoogleLlmDelta
    };
}

const googleLlmDeltaSchema = z.object({
    candidates: z
        .array(
            z.object({
                finishReason: z
                    .enum([
                        'FINISH_REASON_UNSPECIFIED',
                        'STOP',
                        'MAX_TOKENS',
                        'SAFETY',
                        'RECITATION',
                        'OTHER'
                    ])
                    .optional(),
                content: z.object({
                    role: z.enum(['model']),
                    parts: z.array(
                        z.object({
                            text: z.string()
                        })
                    )
                })
            })
        )
        .length(1),
    usageMetadata: z
        .object({
            promptTokenCount: z.number().int().min(0).optional(),
            candidatesTokenCount: z.number().int().min(0).optional(),
            totalTokenCount: z.number().int().min(0).optional()
        })
        .optional(),
    modelVersion: z.string()
});

function parseGoogleLlmDelta(data: string, usage: LLMUsage): LLMDelta {
    try {
        const json = JSON.parse(data);
        const chunk = googleLlmDeltaSchema.parse(json);
        if (
            chunk.usageMetadata &&
            chunk.usageMetadata.promptTokenCount !== undefined &&
            chunk.usageMetadata.candidatesTokenCount !== undefined
        ) {
            usage.promptTokens = chunk.usageMetadata.promptTokenCount;
            usage.completionTokens = chunk.usageMetadata.candidatesTokenCount;
        }
        usage.responseModel = chunk.modelVersion;
        const parts = chunk.candidates[0].content.parts;
        const content = parts.length > 0 ? parts[0].text : undefined;
        return {
            index: 0,
            content,
            ...(chunk.candidates[0].finishReason !== undefined ? { isLast: true } : {})
        };
    } catch (e) {
        console.log(`\
parseGoogleLlmDelta: failed to parse LLM delta: ${errorAsString(e)}
DELTA:
${data}`);
        throw e;
    }
}

async function llmApiConfig(llmRequest: LLMCompletionRequest): Promise<LLMApiConfig> {
    const model = llmRequest.model;
    return await googleLlmApiConfig({ ...llmRequest, model });
}

export async function llmCompletion(llmRequest: LLMCompletionRequest): Promise<string> {
    let text = '';
    for await (const delta of llmTextStream(llmRequest)) {
        text += delta;
    }
    return text;
}

export async function llmStreamCompletion(llmRequest: LLMCompletionRequest) {
    const { url, headers, requestBody, parseDelta } = await llmApiConfig(llmRequest);
    const fetchResponse = await llmFetch({
        url,
        headers,
        requestBody
    });
    const responseBody = fetchResponse.body;
    return { responseBody, parseDelta };
}

export async function* llmStream(llmRequest: LLMCompletionRequest): AsyncGenerator<LLMDelta> {
    const { url, headers, requestBody, parseDelta } = await llmApiConfig(llmRequest);

    let responseText: string | null = null;
    const fetchResponse = await llmFetch({
        url,
        headers,
        requestBody
    });
    const responseBody = fetchResponse.body;

    const llmUsage: LLMUsage = {};
    let onDataCallback: (() => void) | null = null;
    const callOnDataCallback = () => {
        if (onDataCallback) {
            onDataCallback();
            onDataCallback = null;
        }
    };
    const dataQueue: LLMDelta[] = [];
    let llmDone = false;
    let llmError: unknown;

    const textDecoder = new TextDecoder();
    const sseParser = createParser(async (event: ServerSourceEvent) => {
        if (event.type === 'event') {
            if (event.data === '[DONE]') {
                llmDone = true;
            } else {
                const llmDelta = parseDelta(event.data, llmUsage);
                if (llmDelta.content !== undefined) {
                    if (responseText === null) {
                        responseText = llmDelta.content;
                    } else {
                        responseText += llmDelta.content;
                    }
                }
                dataQueue.push(llmDelta);
            }
            callOnDataCallback();
        }
    });

    (async () => {
        const llmReader = responseBody.getReader();
        try {
            for (; ;) {
                const { done, value } = await llmReader.read();
                if (done) {
                    break;
                }
                if (value) {
                    const chunk = textDecoder.decode(value, { stream: true });
                    await sseParser.feed(chunk);
                }
            }
            llmDone = true;
        } catch (e) {
            llmError = e;
        } finally {
            callOnDataCallback();
            llmReader.releaseLock();
        }
    })();

    for (; ;) {
        while (dataQueue.length > 0) {
            yield dataQueue.shift()!;
        }
        if (llmDone) {
            break;
        }
        if (llmError) {
            throw llmError;
        }
        await new Promise<void>((resolve) => (onDataCallback = resolve));
    }
}

export async function* llmTextStream(llmRequest: LLMCompletionRequest): AsyncGenerator<string> {
    for await (const delta of llmStream(llmRequest)) {
        if (delta.content) {
            if (delta.index !== 0) {
                throw Error(`Unexpected non-zero delta index: ${JSON.stringify(delta)}`);
            }
            yield delta.content;
        }
    }
}
