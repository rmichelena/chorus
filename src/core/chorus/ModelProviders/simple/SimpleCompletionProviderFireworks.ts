import {
    ISimpleCompletionProvider,
    SimpleCompletionMode,
    SimpleCompletionParams,
} from "./ISimpleCompletionProvider";

const DEFAULT_TITLE_MODEL = "accounts/fireworks/models/deepseek-v3p1";
const DEFAULT_SUMMARIZER_MODEL =
    "accounts/fireworks/models/deepseek-v3p1";

export class SimpleCompletionProviderFireworks
    implements ISimpleCompletionProvider
{
    constructor(private apiKey: string) {}

    async complete(
        prompt: string,
        params: SimpleCompletionParams,
    ): Promise<string> {
        const model = this.getModel(params.model);
        const stream = createFireworksCompletionStream(this.apiKey, {
            model,
            max_tokens: params.maxTokens,
            stream: true,
            messages: [
                {
                    role: "user",
                    content: prompt,
                },
            ],
        });

        let fullResponse = "";

        for await (const chunk of stream) {
            const delta = chunk.choices?.[0]?.delta?.content;
            if (typeof delta === "string") {
                fullResponse += delta;
            }
        }

        return fullResponse;
    }

    private getModel(model: SimpleCompletionMode | string | undefined): string {
        if (model === SimpleCompletionMode.SUMMARIZER) {
            return DEFAULT_SUMMARIZER_MODEL;
        }
        if (model === SimpleCompletionMode.TITLE_GENERATION) {
            return DEFAULT_TITLE_MODEL;
        }
        if (typeof model === "string") {
            return model;
        }
        return DEFAULT_TITLE_MODEL;
    }
}

type FireworksCompletionChunk = {
    choices?: Array<{
        delta?: {
            content?: string;
        };
    }>;
};

type FireworksCompletionRequest = {
    model: string;
    max_tokens: number;
    stream: true;
    messages: Array<{
        role: "user";
        content: string;
    }>;
};

async function* createFireworksCompletionStream(
    apiKey: string,
    requestBody: FireworksCompletionRequest,
): AsyncGenerator<FireworksCompletionChunk> {
    // Match ProviderFireworks: avoid the OpenAI SDK in WebView because its
    // automatic X-Stainless-* headers are blocked by Fireworks CORS preflight.
    const response = await fetch(
        "https://api.fireworks.ai/inference/v1/chat/completions",
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
        },
    );

    if (!response.ok) {
        throw new Error(await formatFireworksError(response));
    }

    if (!response.body) {
        throw new Error("Fireworks API error: response body is empty");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split(/\r?\n\r?\n/);
            buffer = events.pop() ?? "";

            for (const event of events) {
                const chunk = parseSseEvent(event);
                if (chunk) {
                    yield chunk;
                }
            }
        }

        buffer += decoder.decode();
        const finalChunk = parseSseEvent(buffer);
        if (finalChunk) {
            yield finalChunk;
        }
    } finally {
        reader.releaseLock();
    }
}

function parseSseEvent(event: string): FireworksCompletionChunk | undefined {
    const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n");

    if (!data || data === "[DONE]") {
        return undefined;
    }

    return JSON.parse(data) as FireworksCompletionChunk;
}

async function formatFireworksError(response: Response): Promise<string> {
    const body = await response.text();

    try {
        const data = JSON.parse(body) as {
            message?: string;
            error?: { message?: string; code?: string };
        };
        if (data.error?.message) {
            const code = data.error.code ? ` (${data.error.code})` : "";
            return `Fireworks API error${code}: ${data.error.message}`;
        }
        if (data.message) {
            return `Fireworks API error (${response.status}): ${data.message}`;
        }
    } catch {
        // Fall through to the generic response body below.
    }

    return body
        ? `Fireworks API error (${response.status}): ${body}`
        : `Fireworks API error (${response.status})`;
}
