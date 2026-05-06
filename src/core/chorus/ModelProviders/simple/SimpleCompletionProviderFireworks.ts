import {
    ISimpleCompletionProvider,
    SimpleCompletionMode,
    SimpleCompletionParams,
} from "./ISimpleCompletionProvider";
import {
    FIREWORKS_DEFAULT_BASE_URL,
    streamFireworksChatCompletion,
} from "@core/utilities/FireworksStream";

const DEFAULT_TITLE_MODEL = "accounts/fireworks/models/deepseek-v3p1";
const DEFAULT_SUMMARIZER_MODEL = "accounts/fireworks/models/deepseek-v3p1";

export class SimpleCompletionProviderFireworks
    implements ISimpleCompletionProvider
{
    constructor(private apiKey: string) {}

    async complete(
        prompt: string,
        params: SimpleCompletionParams,
    ): Promise<string> {
        const model = this.getModel(params.model);
        const requestBody = {
            model,
            max_tokens: params.maxTokens,
            stream: true,
            messages: [
                {
                    role: "user" as const,
                    content: prompt,
                },
            ],
        };

        const stream = streamFireworksChatCompletion(
            `${FIREWORKS_DEFAULT_BASE_URL}/chat/completions`,
            this.apiKey,
            requestBody,
        );

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
