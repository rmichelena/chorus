import type OpenAI from "openai";

export const FIREWORKS_DEFAULT_BASE_URL =
    "https://api.fireworks.ai/inference/v1";

interface ProviderError {
    message?: string;
    error?: {
        message?: string;
        code?: string;
        type?: string;
    };
}

export async function* streamFireworksChatCompletion(
    url: string,
    apiKey: string,
    requestBody: unknown,
    additionalHeaders?: Record<string, string>,
): AsyncGenerator<OpenAI.ChatCompletionChunk> {
    // Use direct fetch instead of the OpenAI SDK. The SDK adds browser headers
    // (X-Stainless-*) that Fireworks does not allow in CORS preflight.
    const response = await fetch(url, {
        method: "POST",
        headers: {
            ...(additionalHeaders ?? {}),
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        throw new Error(await formatFireworksResponseError(response));
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

function parseSseEvent(
    event: string,
): OpenAI.ChatCompletionChunk | undefined {
    const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n");

    if (!data || data === "[DONE]") {
        return undefined;
    }

    try {
        return JSON.parse(data) as OpenAI.ChatCompletionChunk;
    } catch {
        // A malformed/truncated SSE payload should not abort the whole stream.
        console.warn("Fireworks: skipping malformed SSE event:", data);
        return undefined;
    }
}

async function formatFireworksResponseError(
    response: Response,
): Promise<string> {
    const body = await response.text();

    try {
        const data = JSON.parse(body) as ProviderError;
        if (data?.error?.message) {
            const code = data.error.code ? ` (${data.error.code})` : "";
            return `Fireworks API error${code}: ${data.error.message}`;
        }
        if (data?.message) {
            return `Fireworks API error (${response.status}): ${data.message}`;
        }
    } catch {
        // Fall through to the generic response body below.
    }

    return body
        ? `Fireworks API error (${response.status}): ${body}`
        : `Fireworks API error (${response.status})`;
}
