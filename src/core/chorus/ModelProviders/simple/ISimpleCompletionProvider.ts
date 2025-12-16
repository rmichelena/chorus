export enum SimpleCompletionMode {
    TITLE_GENERATION = "title_generation",
    SUMMARIZER = "summarizer",
}

export type SimpleCompletionParams = {
    model?: SimpleCompletionMode | string;
    maxTokens: number;
};

/**
 * Lightweight interface for simple LLM completions.
 * Used for utility tasks like generating chat titles and suggestions.
 * Intentionally separate from IProvider to avoid coupling to streaming/tools/attachments.
 */
export interface ISimpleCompletionProvider {
    /**
     * Performs a simple completion request.
     * @param prompt The prompt to send to the model
     * @param params Completion parameters including model and maxTokens
     * @returns The full response text
     */
    complete(prompt: string, params: SimpleCompletionParams): Promise<string>;
}
