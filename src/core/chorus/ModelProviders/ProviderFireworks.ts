import OpenAI from "openai";
import { StreamResponseParams } from "../Models";
import { IProvider } from "./IProvider";
import { canProceedWithProvider } from "@core/utilities/ProxyUtils";
import OpenAICompletionsAPIUtils from "@core/chorus/OpenAICompletionsAPIUtils";
import JSON5 from "json5";

interface ProviderError {
    message: string;
    error?: {
        message?: string;
        code?: string;
        type?: string;
    };
}

export class ProviderFireworks implements IProvider {
    async streamResponse({
        llmConversation,
        modelConfig,
        onChunk,
        onComplete,
        apiKeys,
        additionalHeaders,
        tools,
        customBaseUrl,
    }: StreamResponseParams) {
        const modelName = modelConfig.modelId.split("::")[1];

        const { canProceed, reason } = canProceedWithProvider(
            "fireworks",
            apiKeys,
        );

        if (!canProceed) {
            throw new Error(
                reason || "Please add your Fireworks API key in Settings.",
            );
        }

        const supportsImages =
            modelConfig.supportedAttachmentTypes?.includes("image") ?? false;

        const messages = await OpenAICompletionsAPIUtils.convertConversation(
            llmConversation,
            {
                imageSupport: supportsImages,
                functionSupport: true,
            },
        );

        const fireworksBaseUrl = "https://api.fireworks.ai/inference/v1";
        const baseUrl = (customBaseUrl || fireworksBaseUrl).replace(/\/$/, "");

        const requestBody: OpenAI.ChatCompletionCreateParamsStreaming = {
            model: modelName,
            messages: [
                ...(modelConfig.systemPrompt
                    ? [
                          {
                              role: "system" as const,
                              content: modelConfig.systemPrompt,
                          },
                      ]
                    : []),
                ...messages,
            ],
            stream: true,
            ...(tools && tools.length > 0
                ? {
                      tools: OpenAICompletionsAPIUtils.convertToolDefinitions(
                          tools,
                      ),
                      tool_choice: "auto" as const,
                  }
                : {}),
        };

        try {
            const chunks: OpenAI.ChatCompletionChunk[] = [];
            const stream = await createFireworksStream(
                `${baseUrl}/chat/completions`,
                apiKeys.fireworks!,
                requestBody,
                additionalHeaders,
            );

            for await (const chunk of stream) {
                chunks.push(chunk);
                if (chunk.choices[0]?.delta?.content) {
                    onChunk(chunk.choices[0].delta.content);
                }
            }

            const usage = chunks[chunks.length - 1]?.usage;
            const toolCalls = OpenAICompletionsAPIUtils.convertToolCalls(
                chunks,
                tools ?? [],
            );

            await onComplete(
                undefined,
                toolCalls.length > 0 ? toolCalls : undefined,
                usage
                    ? {
                          prompt_tokens: usage.prompt_tokens,
                          completion_tokens: usage.completion_tokens,
                          total_tokens: usage.total_tokens,
                      }
                    : undefined,
            );
        } catch (error: unknown) {
            console.error(
                "Raw error from ProviderFireworks:",
                error,
                modelName,
                messages,
            );
            const parsed = parseFireworksError(error);
            throw new Error(parsed);
        }
    }
}

async function* createFireworksStream(
    url: string,
    apiKey: string,
    requestBody: OpenAI.ChatCompletionCreateParamsStreaming,
    additionalHeaders?: Record<string, string>,
): AsyncGenerator<OpenAI.ChatCompletionChunk> {
    // Use direct fetch instead of the OpenAI SDK. The SDK adds browser headers
    // that Fireworks does not allow in CORS preflight requests.
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
        throw new Error(
            await parseFireworksResponseError(response.status, response),
        );
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

function parseSseEvent(event: string): OpenAI.ChatCompletionChunk | undefined {
    const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n");

    if (!data || data === "[DONE]") {
        return undefined;
    }

    return JSON5.parse(data) as OpenAI.ChatCompletionChunk;
}

async function parseFireworksResponseError(
    status: number,
    response: Response,
): Promise<string> {
    const body = await response.text();

    try {
        const data = JSON5.parse(body) as ProviderError;
        if (data?.error?.message) {
            const code = data.error.code ? ` (${data.error.code})` : "";
            return `Fireworks API error${code}: ${data.error.message}`;
        }
        if (data?.message) {
            return `Fireworks API error (${status}): ${data.message}`;
        }
    } catch {
        // Fall through to the generic response body below.
    }

    return body
        ? `Fireworks API error (${status}): ${body}`
        : `Fireworks API error (${status})`;
}

function parseFireworksError(error: unknown): string {
    if (!error || typeof error !== "object") {
        return "Unknown Fireworks error";
    }

    const maybeError = error as {
        message?: string;
        error?: { message?: string; code?: string; type?: string };
        response?: { data?: unknown };
    };

    if (maybeError.error?.message) {
        const code = maybeError.error.code ? ` (${maybeError.error.code})` : "";
        return `Fireworks API error${code}: ${maybeError.error.message}`;
    }

    if (maybeError.response?.data) {
        try {
            const data =
                typeof maybeError.response.data === "string"
                    ? JSON5.parse(maybeError.response.data)
                    : (maybeError.response.data as ProviderError);
            if (data?.error?.message) {
                const code = data.error.code ? ` (${data.error.code})` : "";
                return `Fireworks API error${code}: ${data.error.message}`;
            }
        } catch {
            // Ignore parse failures and fall back to generic message
        }
    }

    return maybeError.message || "Unknown Fireworks error";
}
