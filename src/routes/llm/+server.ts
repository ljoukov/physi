import { llmCompletion } from '$lib/util/llm';
import type { RequestHandler } from './$types';
import { text } from '@sveltejs/kit';

export const GET = (async () => {
    const completion = await llmCompletion({
        model: 'gemini-2.0-flash-exp',
        max_tokens: 4096,
        messages: [{ role: 'user', content: 'hello' }]
    });
    return text(completion);
}) satisfies RequestHandler;
