import {
  GOOGLE_API_KEY,
  GOOGLE_REGION,
} from '$env/static/private';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { type Json } from './util/json';
import { errorAsString, responseErrorAsString } from '$lib/util/error';
import { getGoogleAccessToken, googleProjectId } from './util/gcpToken';
import { createParser, type ServerSourceEvent } from '$lib/util/eventsource-parser';
import { genRandomId } from './idgen';
import { queryDB } from './db';

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

export type LLMRequestId = {
  requestId: string;
  tag: string;
};
/Users/yaroslavvolovich / Projects / hobby / flipflop - web / src / lib / server / util / gcpToken.ts / Users / yaroslavvolovich / Projects / hobby / flipflop - web / src / lib / server / util / firestore.ts
const llmLogRequestSchema = z.object({
  messages: z.array(llmMessageSchema),
  maxTokens: z.number(),
  temperature: z.number().optional()
});

type LLMLogRequest = z.infer<typeof llmLogRequestSchema>;

const llmLogRecordSchema = z.object({
  requestId: z.string(),
  createdAtMillis: z.number(),
  completedAtMillis: z.number().nullable(),
  model: llmModelSchema,
  provider: llmProviderSchema,
  tag: z.string(),
  error: z.string().nullable(),
  responseModel: z.string().nullable(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  request: llmLogRequestSchema,
  responseText: z.string()
});

export type LLMLogRecord = z.infer<typeof llmLogRecordSchema>;

export function genLLMRequestId(tag: string): LLMRequestId {
  return { requestId: genRandomId('llm-', 12), tag };
}

export type LLMCompletionRequest = {
  llmRequestId: LLMRequestId;
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
  provider: LLMProvider;
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

async function openAiLlmApiConfig(
  llmRequest: LLMCompletionRequest & { model: OpenAiLLMModel }
): Promise<LLMApiConfig> {
  const provider = openAiProvider;
  const model: string = (() => {
    switch (llmRequest.model) {
      case 'chatgpt-4o-latest':
        return 'chatgpt-4o-latest';
      case 'o1-preview':
        return 'o1-preview';
      case 'o1-mini':
        return 'o1-mini';
      case 'gpt-4o':
        return 'gpt-4o';
      case 'gpt-4':
        return 'gpt-4';
      case 'gpt-4o-mini':
        return 'gpt-4o-mini';
    }
  })();
  const {
    messages,
    max_completion_tokens
  }: {
    messages: OpenAiChatCompletionRequest['messages'];
    max_completion_tokens?: OpenAiChatCompletionRequest['max_completion_tokens'];
  } = (() => {
    switch (llmRequest.model) {
      case 'o1-preview': // fallthrough
      case 'o1-mini':
        // O1 models do not support system messages
        return {
          messages: llmRequest.messages.map((m) =>
            m.role === 'system' ? { role: 'user', content: m.content } : m
          )
        };
      default:
        return { messages: llmRequest.messages, max_completion_tokens: llmRequest.max_tokens };
    }
  })();
  const requestBody: OpenAiChatCompletionRequest = {
    model,
    messages,
    stream: true,
    max_completion_tokens,
    stream_options: { include_usage: true },
    n: llmRequest.n,
    temperature: llmRequest.temperature
  };
  const url: URL = (() => {
    switch (openAiProvider) {
      case 'OPENAI': {
        return new URL('https://api.openai.com/v1/chat/completions');
      }
      case 'CLOUDFLARE_GATEWAY': {
        return new URL(
          `https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${CLOUDFLARE_GATEWAY_SLUG}/openai/chat/completions`
        );
      }
    }
  })();
  return {
    provider,
    url,
    headers: getBearerHeaders(OPENAI_API_KEY),
    requestBody: { ...requestBody, model },
    parseDelta: parseOpenAiDelta
  };
}

async function mistralLlmApiConfig(
  llmRequest: LLMCompletionRequest & { model: MistralLLMModel }
): Promise<LLMApiConfig> {
  const requestBody = {
    messages: llmRequest.messages,
    stream: true,
    max_tokens: llmRequest.max_tokens,
    temperature: llmRequest.temperature ?? 0.2
  };

  const provider = mistralProvider;
  switch (mistralProvider) {
    case 'CLOUDFLARE': {
      const requestModel = (() => {
        switch (llmRequest.model) {
          case 'mistral-7b-instruct':
            return '@cf/mistral/mistral-7b-instruct-v0.1';
        }
      })();
      const url = `https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${CLOUDFLARE_GATEWAY_SLUG}/workers-ai/${requestModel}`;
      return {
        provider,
        url: new URL(url),
        headers: getBearerHeaders(WORKERS_AI_TOKEN),
        requestBody: { ...requestBody, model: requestModel, temperature: 0 },
        parseDelta: parseCloudflareDelta
      };
    }
    case 'OPEN_ROUTER': {
      const requestModel = (() => {
        switch (llmRequest.model) {
          case 'mistral-7b-instruct':
            return 'mistralai/mistral-7b-instruct';
        }
      })();
      return {
        provider,
        url: new URL('https://openrouter.ai/api/v1/chat/completions'),
        headers: getBearerHeaders(OPENROUTER_TOKEN),
        requestBody: { ...requestBody, model: requestModel },
        parseDelta: parseOpenAiDelta
      };
    }
  }
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
  provider: 'GOOGLE_AI' | 'VERTEX_AI'
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
  const threshold: GoogleLlmRequest['safetySettings'][number]['threshold'] = (() => {
    switch (provider) {
      case 'GOOGLE_AI':
        return 'BLOCK_NONE';
      case 'VERTEX_AI':
        return 'BLOCK_ONLY_HIGH';
    }
  })();
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
  const provider = googleLlmProvider;
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
  switch (provider) {
    case 'GOOGLE_AI': {
      const url = new URL(
        `https://generativelanguage.googleapis.com/${version}/models/${model}:streamGenerateContent?alt=sse`
      );
      return {
        provider,
        url,
        headers: { 'X-goog-api-key': GOOGLE_API_KEY },
        requestBody: getGoogleLlmRequestBody(llmRequest, provider),
        parseDelta: parseGoogleLlmDelta
      };
    }
    case 'VERTEX_AI': {
      const url = new URL(
        `https://${GOOGLE_REGION}-aiplatform.googleapis.com/${version}/projects/${googleProjectId}/locations/${GOOGLE_REGION}/publishers/google/models/${model}:streamGenerateContent?alt=sse`
      );
      return {
        provider,
        url,
        headers: getBearerHeaders(await getVertexAuthToken()),
        requestBody: getGoogleLlmRequestBody(llmRequest, provider),
        parseDelta: parseGoogleLlmDelta
      };
    }
    case 'CLOUDFLARE_GATEWAY': {
      const url = new URL(
        `https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${CLOUDFLARE_GATEWAY_SLUG}/google-ai-studio/${version}/models/${model}:streamGenerateContent?alt=sse`
      );
      return {
        provider,
        url,
        headers: { 'X-goog-api-key': GOOGLE_API_KEY },
        requestBody: getGoogleLlmRequestBody(llmRequest, 'GOOGLE_AI'),
        parseDelta: parseGoogleLlmDelta
      };
    }
  }
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

async function anthropicLlmApiConfig(
  llmRequest: LLMCompletionRequest & { model: AnthropicLLMModel }
): Promise<LLMApiConfig> {
  const provider = anthropicProvider;
  switch (anthropicProvider) {
    case 'ANTHROPIC': {
      const url = new URL('https://api.anthropic.com/v1/messages');
      const model = (() => {
        switch (llmRequest.model) {
          case 'claude-3-5-sonnet':
            return 'claude-3-5-sonnet-20241022';
          case 'claude-3-opus':
            return 'claude-3-opus-20240229';
          case 'claude-3-haiku':
            return 'claude-3-haiku-20240307';
        }
      })();
      const requestBody = {
        model,
        ...getAnthropicLlmMessages(llmRequest.messages),
        max_tokens: llmRequest.max_tokens,
        stream: true,
        ...(llmRequest.temperature ? { temperature: llmRequest.temperature } : {})
      };
      return {
        provider,
        url,
        headers: {
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'messages-2023-12-15',
          'x-api-key': ANTHROPIC_API_KEY
        },
        requestBody,
        parseDelta: parseAnthropicLlmDelta
      };
    }
    case 'CLOUDFLARE_GATEWAY': {
      const url = new URL(
        `https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${CLOUDFLARE_GATEWAY_SLUG}/anthropic/v1/messages`
      );
      const model = (() => {
        switch (llmRequest.model) {
          case 'claude-3-5-sonnet':
            return 'claude-3-5-sonnet-20241022';
          case 'claude-3-opus':
            return 'claude-3-opus-20240229';
          case 'claude-3-haiku':
            return 'claude-3-haiku-20240307';
        }
      })();
      const requestBody = {
        model,
        ...getAnthropicLlmMessages(llmRequest.messages),
        max_tokens: llmRequest.max_tokens,
        stream: true,
        ...(llmRequest.temperature ? { temperature: llmRequest.temperature } : {})
      };
      return {
        provider,
        url,
        headers: {
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'messages-2023-12-15',
          'x-api-key': ANTHROPIC_API_KEY
        },
        requestBody,
        parseDelta: parseAnthropicLlmDelta
      };
    }
    case 'VERTEX_AI': {
      const model = (() => {
        switch (llmRequest.model) {
          case 'claude-3-5-sonnet':
            return 'claude-3-5-sonnet@20240620';
          case 'claude-3-opus':
            return 'claude-3-opus@20240229';
          case 'claude-3-haiku':
            return 'claude-3-haiku@20240307';
        }
      })();
      const url = new URL(`\
https://${ANTHROPIC_VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/\
${googleProjectId}/locations/${ANTHROPIC_VERTEX_REGION}\
/publishers/anthropic/models/${model}:streamRawPredict`);
      return {
        provider,
        url,
        headers: getBearerHeaders(await getVertexAuthToken()),
        requestBody: {
          anthropic_version: 'vertex-2023-10-16',
          ...getAnthropicLlmMessages(llmRequest.messages),
          max_tokens: llmRequest.max_tokens,
          stream: true,
          ...(llmRequest.temperature ? { temperature: llmRequest.temperature } : {})
        },
        parseDelta: parseAnthropicLlmDelta
      };
    }
    case 'CLOUDFLARE_GATEWAY_VERTEX_AI': {
      const model = (() => {
        switch (llmRequest.model) {
          case 'claude-3-5-sonnet':
            return 'claude-3-5-sonnet@20240620';
          case 'claude-3-opus':
            return 'claude-3-opus@20240229';
          case 'claude-3-haiku':
            return 'claude-3-haiku@20240307';
        }
      })();
      const url = new URL(`\
https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${CLOUDFLARE_GATEWAY_SLUG}/google-vertex-ai/\
v1/projects/\
${googleProjectId}/locations/${ANTHROPIC_VERTEX_REGION}\
/publishers/anthropic/models/${model}:streamRawPredict`);
      return {
        provider,
        url,
        headers: getBearerHeaders(await getVertexAuthToken()),
        requestBody: {
          anthropic_version: 'vertex-2023-10-16',
          ...getAnthropicLlmMessages(llmRequest.messages),
          max_tokens: llmRequest.max_tokens,
          stream: true,
          ...(llmRequest.temperature ? { temperature: llmRequest.temperature } : {})
        },
        parseDelta: parseAnthropicLlmDelta
      };
    }
  }
}

type AnthropicLlmMessage = {
  role: 'user' | 'assistant';
  content: string;
};

function getAnthropicLlmMessages(messages: LLMMessage[]): {
  system?: string;
  messages: AnthropicLlmMessage[];
} {
  if (messages.length === 0) {
    throw Error('getAnthropicLlmMessages: no messages in LLM request');
  }
  if (messages[0].role === 'system') {
    if (messages.length === 1) {
      return { messages: [{ role: 'user', content: messages[0].content }] };
    } else {
      switch (messages[1].role) {
        case 'user':
          // system, user, ...
          return {
            system: messages[0].content,
            messages: messages.slice(1).map((m) => ({
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: m.content
            }))
          };
        case 'assistant':
          // system, assistant -> user, assistant
          return {
            messages: messages.map((m) => ({
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: m.content
            }))
          };
        case 'system':
          throw Error('getAnthropicLlmMessages: two system messages');
      }
    }
  } else {
    return {
      messages: messages.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content
      }))
    };
  }
}

const anthropicDeltaSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message_start'),
    message: z.object({
      id: z.string(),
      type: z.literal('message'),
      role: z.literal('assistant'),
      model: z.string(),
      content: z.array(z.object({})).length(0),
      stop_reason: z.string().nullable(),
      stop_sequence: z.string().nullable(),
      usage: z.object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative()
      })
    })
  }),
  z.object({
    type: z.literal('ping')
  }),
  z.object({
    type: z.literal('content_block_start'),
    index: z.number(),
    content_block: z.object({
      type: z.literal('text'),
      text: z.string()
    })
  }),
  z.object({
    type: z.literal('content_block_delta'),
    index: z.number(),
    delta: z.object({
      type: z.literal('text_delta'),
      text: z.string()
    })
  }),
  z.object({
    type: z.literal('content_block_stop'),
    index: z.number()
  }),
  z.object({
    type: z.literal('message_delta'),
    delta: z.object({
      stop_reason: z.string().nullable(),
      stop_sequence: z.string().nullable()
    }),
    usage: z.object({
      output_tokens: z.number()
    })
  }),
  z.object({
    type: z.literal('message_stop')
  }),
  z.object({
    type: z.literal('error'),
    error: z.object({
      type: z.string(),
      message: z.string()
    })
  })
]);

function parseAnthropicLlmDelta(data: string, usage: LLMUsage): LLMDelta {
  try {
    const json = JSON.parse(data);
    const delta = anthropicDeltaSchema.parse(json);
    switch (delta.type) {
      case 'error':
        throw Error(`anthropic_error=${delta.error.message}`);
      case 'message_start':
        usage.responseModel = delta.message.model;
        usage.promptTokens = delta.message.usage.input_tokens;
        usage.completionTokens = delta.message.usage.output_tokens;
        return {
          index: 0,
          content: undefined
        };
      case 'ping':
        return {
          index: 0,
          content: undefined
        };
      case 'content_block_start':
        return {
          index: 0,
          content: undefined
        };
      case 'content_block_delta':
        return {
          index: 0,
          content: delta.delta.text
        };
      case 'content_block_stop':
        return {
          index: 0,
          content: undefined
        };
      case 'message_delta':
        usage.completionTokens = delta.usage.output_tokens;
        return {
          index: 0,
          content: undefined
        };
      case 'message_stop':
        return {
          index: 0,
          content: undefined,
          isLast: true
        };
    }
  } catch (e) {
    console.log(`parseAnthropicLlmDelta: failed to parse LLM delta: ${errorAsString(e)}
DELTA:
${data}`);
    throw e;
  }
}

async function cohereLlmApiConfig(
  llmRequest: LLMCompletionRequest & { model: CohereLLMModel }
): Promise<LLMApiConfig> {
  const provider = cohereProvider;
  switch (cohereProvider) {
    case 'COHERE': {
      const url = new URL('https://api.cohere.ai/v1/chat');
      const requestBody = {
        model: llmRequest.model,
        messages: llmRequest.messages,
        max_tokens: llmRequest.max_tokens,
        stream: true
      };
      return {
        provider,
        url,
        headers: getBearerHeaders(COHERE_API_KEY),
        requestBody,
        parseDelta: parseOpenAiDelta // FIXME
      };
    }
  }
}

async function llamaLlmApiConfig(
  llmRequest: LLMCompletionRequest & { model: LlamaLLMModel }
): Promise<LLMApiConfig> {
  const requestBody = {
    messages: llmRequest.messages,
    stream: true,
    max_tokens: llmRequest.max_tokens,
    ...(llmRequest.n ? { n: llmRequest.n } : {}),
    ...(llmRequest.temperature ? { temperature: llmRequest.temperature } : {})
  };

  const provider = llamaProvider;
  switch (provider) {
    case 'CLOUDFLARE': {
      const requestModel = (() => {
        switch (llmRequest.model) {
          case 'llama-3.1-8B-instruct':
            return '@cf/meta/llama-3.1-8b-instruct';
          case 'llama-3.1-70B-instruct':
            throw Error(`Model ${llmRequest.model} is not supported on ${llamaProvider}`);
          case 'llama-3.1-405B-instruct':
            throw Error(`Model ${llmRequest.model} is not supported on ${llamaProvider}`);
        }
      })();
      const url = `https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${CLOUDFLARE_GATEWAY_SLUG}/workers-ai/${requestModel}`;
      return {
        provider,
        url: new URL(url),
        headers: getBearerHeaders(WORKERS_AI_TOKEN),
        requestBody: { ...requestBody, model: requestModel, temperature: 0 },
        parseDelta: parseCloudflareDelta
      };
    }
    case 'FIREWORKS': {
      const requestModel = (() => {
        switch (llmRequest.model) {
          case 'llama-3.1-8B-instruct':
            return 'accounts/fireworks/models/llama-v3p1-8b-instruct';
          case 'llama-3.1-70B-instruct':
            return 'accounts/fireworks/models/llama-v3p1-70b-instruct';
          case 'llama-3.1-405B-instruct':
            return 'accounts/fireworks/models/llama-v3p1-405b-instruct';
        }
      })();
      return {
        provider,
        url: new URL('https://api.fireworks.ai/inference/v1/chat/completions'),
        headers: getBearerHeaders(FIREWORKS_TOKEN),
        requestBody: { ...requestBody, model: requestModel },
        parseDelta: parseOpenAiDelta
      };
    }
    case 'TOGETHER': {
      const requestModel = (() => {
        switch (llmRequest.model) {
          case 'llama-3.1-8B-instruct':
            return 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo';
          case 'llama-3.1-70B-instruct':
            return 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo';
          case 'llama-3.1-405B-instruct':
            return 'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo';
        }
      })();
      return {
        provider,
        url: new URL('https://api.together.xyz/v1/chat/completions'),
        headers: getBearerHeaders(TOGETHER_TOKEN),
        requestBody: { ...requestBody, model: requestModel },
        parseDelta: parseTogetherDelta
      };
    }
    case 'GROQ': {
      const requestModel = (() => {
        switch (llmRequest.model) {
          case 'llama-3.1-8B-instruct':
            return 'llama-3.1-8b-instant';
          case 'llama-3.1-70B-instruct':
            return 'llama-3.1-70b-versatile';
          case 'llama-3.1-405B-instruct':
            throw Error(`Model ${llmRequest.model} is not supported on ${llamaProvider}`);
        }
      })();
      return {
        provider,
        url: new URL('https://api.groq.com/openai/v1/chat/completions'),
        headers: getBearerHeaders(GROQ_TOKEN),
        requestBody: { ...requestBody, model: requestModel },
        parseDelta: parseOpenAiDelta
      };
    }
    case 'SAMBANOVA': {
      const requestModel = (() => {
        switch (llmRequest.model) {
          case 'llama-3.1-8B-instruct':
            return 'Meta-Llama-3.1-8B-Instruct';
          case 'llama-3.1-70B-instruct':
            return 'Meta-Llama-3.1-70B-Instruct';
          case 'llama-3.1-405B-instruct':
            return 'Meta-Llama-3.1-405B-Instruct';
        }
      })();
      return {
        provider,
        url: new URL('https://api.sambanova.ai/v1/chat/completions'),
        headers: getBearerHeaders(SAMBANOVA_TOKEN),
        requestBody: { ...requestBody, model: requestModel },
        parseDelta: parseOpenAiDelta
      };
    }
  }
}

async function xaiLlmApiConfig(
  llmRequest: LLMCompletionRequest & { model: XaiLLMModel }
): Promise<LLMApiConfig> {
  const requestBody = {
    messages: llmRequest.messages,
    stream: true,
    max_tokens: llmRequest.max_tokens,
    stream_options: { include_usage: true },
    ...(llmRequest.n ? { n: llmRequest.n } : {}),
    ...(llmRequest.temperature ? { temperature: llmRequest.temperature } : {})
  };
  const provider = xaiProvider;
  const url: URL = (() => {
    switch (provider) {
      case 'XAI':
        return new URL('https://api.x.ai/v1/chat/completions');
      case 'CLOUDFLARE_GATEWAY':
        return new URL(
          `https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${CLOUDFLARE_GATEWAY_SLUG}/grok/v1/chat/completions`
        );
    }
  })();
  const model: string = (() => {
    switch (llmRequest.model) {
      case 'grok-beta':
        return 'grok-beta';
      case 'grok-2-latest':
        return 'grok-2-latest';
    }
  })();
  return {
    provider,
    url,
    headers: getBearerHeaders(XAI_API_KEY),
    requestBody: { ...requestBody, model },
    parseDelta: parseXaiDelta
  };
}

const xAiCompletionChunkSchema = z.object({
  id: z.string(),
  created: z.number(),
  model: z.string(),
  choices: z
    .array(
      z.object({
        index: z.number().int().min(0),
        delta: z.object({
          content: z.string().optional().nullable()
        }),
        finish_reason: z.string().nullable().optional()
      })
    )
    .max(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().min(0),
      completion_tokens: z.number().int().min(0),
      total_tokens: z.number().int().min(0),
      prompt_tokens_details: z
        .object({
          cached_tokens: z.number().int().min(0)
        })
        .optional(),
      completion_tokens_details: z
        .object({
          reasoning_tokens: z.number().int().min(0)
        })
        .optional()
    })
    .nullable()
    .optional()
});

function parseXaiDelta(data: string, usage: LLMUsage): LLMDelta {
  const json = JSON.parse(data);
  try {
    const chunk = xAiCompletionChunkSchema.parse(json);
    usage.responseModel = chunk.model;
    if (chunk.usage) {
      usage.promptTokens = chunk.usage.prompt_tokens;
      usage.completionTokens = chunk.usage.completion_tokens;
    }
    if (chunk.choices.length === 0) {
      if (chunk.usage === undefined || chunk.usage === null) {
        throw Error(
          `parseXaiDelta: inalid completion: missing choices and usage: ${JSON.stringify(chunk)}`
        );
      }
      return {
        index: 0,
        isLast: true
      };
    } else {
      const choice = chunk.choices[0];
      const isLast = (() => {
        const { finish_reason } = choice;
        if (finish_reason === null || finish_reason === undefined) {
          return false;
        }
        const _x: string = finish_reason;
        return true;
      })();
      return {
        index: choice.index,
        content: choice.delta?.content ?? undefined,
        isLast
      };
    }
  } catch (e) {
    console.log(`\
parseparseOpenAiDelta: failed to parse LLM delta: ${errorAsString(e)}
DELTA:
${data}`);
    throw e;
  }
}

async function llmApiConfig(llmRequest: LLMCompletionRequest): Promise<LLMApiConfig> {
  const model = llmRequest.model;
  if (isOpenAiModel(model)) {
    return await openAiLlmApiConfig({ ...llmRequest, model });
  } else if (isMistralModel(model)) {
    return await mistralLlmApiConfig({ ...llmRequest, model });
  } else if (isGoogleModel(model)) {
    return await googleLlmApiConfig({ ...llmRequest, model });
  } else if (isAnthropicModel(model)) {
    return await anthropicLlmApiConfig({ ...llmRequest, model });
  } else if (isCohereModel(model)) {
    return await cohereLlmApiConfig({ ...llmRequest, model });
  } else if (isLlamaModel(model)) {
    return await llamaLlmApiConfig({ ...llmRequest, model });
  } else if (isXaiModel(model)) {
    return await xaiLlmApiConfig({ ...llmRequest, model });
  } else {
    return model; // if we enumerated all possible models, the model should be of type 'never'.
  }
}

export async function llmCompletion(llmRequest: LLMCompletionRequest): Promise<string> {
  let text = '';
  for await (const delta of llmTextStream(llmRequest)) {
    text += delta;
  }
  return text;
}

export async function llmStreamCompletion(llmRequest: LLMCompletionRequest) {
  const { provider, url, headers, requestBody, parseDelta } = await llmApiConfig(llmRequest);
  const fetchResponse = await llmFetch({
    url,
    headers,
    requestBody
  });
  const responseBody = fetchResponse.body;
  return { responseBody, parseDelta, provider };
}

export async function* llmStream(llmRequest: LLMCompletionRequest): AsyncGenerator<LLMDelta> {
  const { provider, url, headers, requestBody, parseDelta } = await llmApiConfig(llmRequest);

  const requestId = llmRequest.llmRequestId.requestId;
  await insertLlmLogNoThrow({
    requestId,
    tag: llmRequest.llmRequestId.tag,
    model: llmRequest.model,
    provider,
    request: {
      messages: llmRequest.messages,
      maxTokens: llmRequest.max_tokens,
      temperature: llmRequest.temperature
    }
  });

  let responseText: string | null = null;
  try {
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
    await updateCompletedLlmLogNoThrow({
      requestId,
      responseText,
      responseModel: llmUsage.responseModel ?? null,
      promptTokens: llmUsage.promptTokens ?? 0,
      completionTokens: llmUsage.completionTokens ?? 0
    });
  } catch (e) {
    await updateFailedLlmLogNoThrow({ requestId, responseText, error: errorAsString(e) });
    throw e;
  }
}

async function insertLlmLogNoThrow({
  requestId,
  tag,
  model,
  provider,
  request
}: {
  requestId: string;
  tag: string;
  model: string;
  provider: string;
  request: LLMLogRequest;
}) {
  const createdAtMillis = Date.now();
  try {
    await queryDB(
      `\
INSERT INTO llm_log (request_id, created_at, model, tag, provider, request)
VALUES ($1, $2, $3, $4, $5, $6)`,
      [requestId, createdAtMillis, model, tag, provider, JSON.stringify(request)]
    );
  } catch (e) {
    console.log(`insertLlmLog: failed: ${errorAsString(e)}`);
  }
}

async function updateCompletedLlmLogNoThrow({
  requestId,
  responseText,
  responseModel,
  promptTokens,
  completionTokens
}: {
  requestId: string;
  responseText: string | null;
  responseModel: string | null;
  promptTokens: number;
  completionTokens: number;
}) {
  const completedAtMillis = Date.now();
  try {
    await queryDB(
      `\
UPDATE llm_log
SET response_text = $1, response_model = $2, prompt_tokens = $3, completion_tokens = $4, completed_at = $5
WHERE request_id = $6`,
      [responseText, responseModel, promptTokens, completionTokens, completedAtMillis, requestId]
    );
  } catch (e) {
    console.log(`updateCompletedLlmLog: failed: ${errorAsString(e)}`);
  }
}

async function updateFailedLlmLogNoThrow({
  requestId,
  responseText,
  error
}: {
  requestId: string;
  responseText: string | null;
  error: string;
}) {
  const completedAtMillis = Date.now();
  try {
    await queryDB(
      `\
UPDATE llm_log
SET response_text = $1, error = $2, completed_at = $3
WHERE request_id = $4`,
      [responseText, error, completedAtMillis, requestId]
    );
  } catch (e) {
    console.log(`updateFailedLlmLog: failed: ${errorAsString(e)}`);
  }
}

export function llmCost({
  promptTokens,
  completionTokens,
  model
}: {
  promptTokens: number;
  completionTokens: number;
  model: LLMModel;
  provider: LLMProvider;
}): number | undefined {
  switch (model) {
    case 'chatgpt-4o-latest':
      return (promptTokens * 5) / 1e6 + (completionTokens * 15) / 1e6;
    case 'o1-preview':
      return (promptTokens * 15) / 1e6 + (completionTokens * 60) / 1e6;
    case 'o1-mini':
      return (promptTokens * 3) / 1e6 + (completionTokens * 12) / 1e6;
    case 'gpt-4o':
      return (promptTokens * 2.5) / 1e6 + (completionTokens * 10) / 1e6;
    case 'gpt-4o-mini':
      return (promptTokens * 0.15) / 1e6 + (completionTokens * 0.6) / 1e6;
    case 'claude-3-opus':
      return (promptTokens * 15) / 1e6 + (completionTokens * 75) / 1e6;
    case 'claude-3-5-sonnet':
      return (promptTokens * 3) / 1e6 + (completionTokens * 15) / 1e6;
    case 'claude-3-haiku':
      return (promptTokens * 0.25) / 1e6 + (completionTokens * 1.25) / 1e6;
    case 'gemini-1.5-pro-002':
      return (promptTokens * 1.25) / 1e6 + (completionTokens * 5) / 1e6;
    case 'gemini-1.5-flash-002':
      return (promptTokens * 0.075) / 1e6 + (completionTokens * 0.3) / 1e6;
    case 'grok-beta':
      return (promptTokens * 5) / 1e6 + (completionTokens * 15) / 1e6;
    case 'grok-2-latest':
      return (promptTokens * 2) / 1e6 + (completionTokens * 10) / 1e6;
  }
  return undefined;
}

export async function readLatestLLMLogs({ limit }: { limit: number }): Promise<LLMLogRecord[]> {
  const rows = await queryDB(
    `\
SELECT
  request_id,
  created_at,
  model,
  tag,
  provider,
  error,
  completed_at,
  response_model,
  prompt_tokens,
  completion_tokens,
  request,
  response_text
FROM llm_log
ORDER BY created_at DESC
LIMIT $1`,
    [limit]
  );
  const records: LLMLogRecord[] = [];
  for (const row of rows) {
    const [
      requestId,
      createdAtMillis,
      modelString,
      tag,
      providerString,
      error,
      completedAtMillis,
      responseModel,
      promptTokens,
      completionTokens,
      requestJsonText,
      responseText
    ] = row as [
      string, // requestId
      number, // createdAtMillis
      string, // model
      string, // tag
      string, // provider
      string | null, // error
      number | null, // completedAtMillis
      string | null, // responseModel
      number, // promptTokens
      number, // completionTokens
      string, // requestJsonText
      string | null // responseText
    ];
    const model = llmModelSchema.parse(modelString);
    const provider = llmProviderSchema.parse(providerString);
    const request = llmLogRequestSchema.parse(JSON.parse(requestJsonText));
    const record: LLMLogRecord = {
      requestId,
      createdAtMillis,
      completedAtMillis,
      model,
      provider,
      tag,
      error,
      responseModel,
      promptTokens,
      completionTokens,
      request,
      responseText: responseText ?? ''
    };
    records.push(record);
  }
  return records;
}

export async function readLLMLogRecord({
  requestId
}: {
  requestId: string;
}): Promise<LLMLogRecord> {
  const rows = await queryDB(
    `\
SELECT
  created_at,
  model,
  tag,
  provider,
  error,
  completed_at,
  response_model,
  prompt_tokens,
  completion_tokens,
  request,
  response_text
FROM llm_log
WHERE request_id = $1`,
    [requestId]
  );
  const records: LLMLogRecord[] = [];
  if (rows.length !== 1) {
    throw error(404, `readLLMLogRecord: llm record with request_id='${requestId}' not found`);
  }
  const row = rows[0];
  const [
    createdAtMillis,
    modelString,
    tag,
    providerString,
    errorString,
    completedAtMillis,
    responseModel,
    promptTokens,
    completionTokens,
    requestJsonText,
    responseText
  ] = row as [
    number, // createdAtMillis
    string, // model
    string, // tag
    string, // provider
    string | null, // error
    number | null, // completedAtMillis
    string | null, // responseModel
    number, // promptTokens
    number, // completionTokens
    string, // requestJsonText
    string | null // responseText
  ];
  const model = llmModelSchema.parse(modelString);
  const provider = llmProviderSchema.parse(providerString);
  const request = llmLogRequestSchema.parse(JSON.parse(requestJsonText));
  const record: LLMLogRecord = {
    requestId,
    createdAtMillis,
    completedAtMillis,
    model,
    provider,
    tag,
    error: errorString,
    responseModel,
    promptTokens,
    completionTokens,
    request,
    responseText: responseText ?? ''
  };
  return record;
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

const openAiChatCompletionRequestSchema = z.object({
  messages: z.array(
    z.discriminatedUnion('role', [
      z.object({
        role: z.literal('system'),
        content: z.string()
      }),
      z.object({
        role: z.literal('user'),
        content: z.string()
      }),
      z.object({
        role: z.literal('assistant'),
        content: z.string()
      }),
      z.object({
        role: z.literal('tool'),
        content: z.string(),
        tool_call_id: z.string()
      }),
      z.object({
        role: z.literal('function'),
        content: z.string()
      })
    ])
  ),
  model: z.string(),
  store: z.boolean().optional(),
  metadata: z.record(z.string()).optional(),
  frequency_penalty: z.number().optional(),
  logit_bias: z.record(z.string(), z.number()).optional(),
  logprobs: z.boolean().optional(),
  top_logprobs: z.number().int().min(0).max(20).optional(),
  max_completion_tokens: z.number().int().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  n: z.number().int().optional(),
  stream: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
  temperature: z.union([z.number(), z.null()]).optional(),
  top_p: z.union([z.number(), z.null()]).optional()
});

export type OpenAiChatCompletionRequest = z.infer<typeof openAiChatCompletionRequestSchema>;

const openAiCompletionChunkSchema = z.object({
  id: z.string(),
  created: z.number(),
  model: z.string(),
  choices: z
    .array(
      z.object({
        index: z.number().int().min(0),
        delta: z.object({
          content: z.string().optional().nullable()
        }),
        finish_reason: z.string().nullable()
      })
    )
    .max(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().min(0),
      completion_tokens: z.number().int().min(0),
      total_tokens: z.number().int().min(0),
      prompt_tokens_details: z
        .object({
          cached_tokens: z.number().int().min(0)
        })
        .optional(),
      completion_tokens_details: z
        .object({
          reasoning_tokens: z.number().int().min(0)
        })
        .optional()
    })
    .nullable()
    .optional()
});

function parseOpenAiDelta(data: string, usage: LLMUsage): LLMDelta {
  const json = JSON.parse(data);
  try {
    const chunk = openAiCompletionChunkSchema.parse(json);
    usage.responseModel = chunk.model;
    if (chunk.usage) {
      usage.promptTokens = chunk.usage.prompt_tokens;
      usage.completionTokens = chunk.usage.completion_tokens;
    }
    if (chunk.choices.length === 0) {
      if (chunk.usage === undefined || chunk.usage === null) {
        throw Error(
          `parseOpenAiDelta: inalid completion: missing choices and usage: ${JSON.stringify(chunk)}`
        );
      }
      return {
        index: 0,
        isLast: true
      };
    } else {
      const choice = chunk.choices[0];
      return {
        index: choice.index,
        content: choice.delta?.content ?? undefined,
        isLast: choice.finish_reason != null
      };
    }
  } catch (e) {
    console.log(`\
parseparseOpenAiDelta: failed to parse LLM delta: ${errorAsString(e)}
DELTA:
${data}`);
    throw e;
  }
}

const cloudflareLLMResponseSchema = z.object({ response: z.string() });

function parseCloudflareDelta(data: string): LLMDelta {
  return { index: 0, content: cloudflareLLMResponseSchema.parse(JSON.parse(data)).response };
}

const togetherCompletionChunkSchema = z.object({
  id: z.string(),
  choices: z
    .array(
      z.object({
        index: z.number().int().min(0),
        delta: z.object({
          content: z.string()
        })
      })
    )
    .length(1) /* always length 1 */
});

function parseTogetherDelta(data: string): LLMDelta {
  const json = JSON.parse(data);
  const choice = togetherCompletionChunkSchema.parse(json).choices[0];
  return { index: choice.index, content: choice.delta.content };
}
