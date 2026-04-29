import OpenAI from "openai";
import {
    ISimpleCompletionProvider,
    SimpleCompletionMode,
    SimpleCompletionParams,
} from "./ISimpleCompletionProvider";

const DEFAULT_TITLE_MODEL = "accounts/fireworks/models/llama-v3p1-8b-instruct";
const DEFAULT_SUMMARIZER_MODEL =
    "accounts/fireworks/models/llama-v3p1-8b-instruct";

export class SimpleCompletionProviderFireworks
    implements ISimpleCompletionProvider
{
    constructor(private apiKey: string) {}

    async complete(
        prompt: string,
        params: SimpleCompletionParams,
    ): Promise<string> {
        const client = new OpenAI({
            baseURL: "https://api.fireworks.ai/inference/v1",
            apiKey: this.apiKey,
            dangerouslyAllowBrowser: true,
        });

        const model = this.getModel(params.model);

        const stream = await client.chat.completions.create({
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
