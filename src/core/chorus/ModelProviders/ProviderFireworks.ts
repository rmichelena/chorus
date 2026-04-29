import OpenAI from "openai";
import { StreamResponseParams } from "../Models";
import { IProvider } from "./IProvider";
import { canProceedWithProvider } from "@core/utilities/ProxyUtils";
import OpenAICompletionsAPIUtils from "@core/chorus/OpenAICompletionsAPIUtils";

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

        const client = new OpenAI({
            baseURL: customBaseUrl || "https://api.fireworks.ai/inference/v1",
            apiKey: apiKeys.fireworks,
            defaultHeaders: {
                ...(additionalHeaders ?? {}),
                "Content-Type": "application/json",
            },
            dangerouslyAllowBrowser: true,
        });

        const stream = await client.chat.completions.create({
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
        });

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
    }
}
