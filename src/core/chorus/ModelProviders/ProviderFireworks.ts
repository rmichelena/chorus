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
        const createClient = (baseURL: string) =>
            new OpenAI({
                baseURL,
                apiKey: apiKeys.fireworks,
                defaultHeaders: {
                    ...(additionalHeaders ?? {}),
                    "Content-Type": "application/json",
                },
                dangerouslyAllowBrowser: true,
            });

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
            let stream: AsyncIterable<OpenAI.ChatCompletionChunk>;
            try {
                stream = await createClient(
                    customBaseUrl || fireworksBaseUrl,
                ).chat.completions.create(requestBody);
            } catch (firstError) {
                // If user configured a custom base URL and that path fails with
                // a connection-level issue, retry directly against Fireworks.
                if (
                    customBaseUrl &&
                    isConnectionLevelError(firstError) &&
                    customBaseUrl !== fireworksBaseUrl
                ) {
                    console.warn(
                        "[ProviderFireworks] custom base URL failed; retrying with default Fireworks endpoint",
                        customBaseUrl,
                    );
                    stream = await createClient(
                        fireworksBaseUrl,
                    ).chat.completions.create(requestBody);
                } else {
                    throw firstError;
                }
            }

            const chunks: OpenAI.ChatCompletionChunk[] = [];

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

function isConnectionLevelError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
        return false;
    }
    const e = error as { message?: string; status?: number };
    const msg = (e.message || "").toLowerCase();
    return (
        e.status === undefined &&
        (msg.includes("connection error") ||
            msg.includes("network error") ||
            msg.includes("fetch failed") ||
            msg.includes("timeout"))
    );
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
