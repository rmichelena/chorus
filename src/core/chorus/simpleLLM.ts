import { SettingsManager } from "@core/utilities/Settings";
import { getSimpleCompletionProvider } from "./ModelProviders/simple/SimpleCompletionProviderFactory";
import {
    SimpleCompletionParams,
    SimpleCompletionMode,
} from "./ModelProviders/simple/ISimpleCompletionProvider";

/**
 * Makes a simple LLM call using the first available provider.
 * Used primarily for generating chat titles and suggestions.
 */
export async function simpleLLM(
    prompt: string,
    params: SimpleCompletionParams,
): Promise<string> {
    const settingsManager = SettingsManager.getInstance();
    const settings = await settingsManager.get();
    const apiKeys = settings.apiKeys || {};

    // Default to title generation mode if no model specified
    const paramsWithMode: SimpleCompletionParams = {
        ...params,
        model: params.model ?? SimpleCompletionMode.TITLE_GENERATION,
    };

    const provider = getSimpleCompletionProvider(apiKeys);
    return provider.complete(prompt, paramsWithMode);
}
