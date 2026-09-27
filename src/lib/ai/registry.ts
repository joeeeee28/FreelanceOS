/**
 * Resolves the configured provider.
 *
 * There is one contract and one implementation. An unknown key returns null
 * so the caller can fail closed — it must not construct a commercial client
 * to "fill the gap".
 */

import { OllamaProvider, type OllamaProviderOptions } from "./ollama";
import type { AiProvider } from "./provider";

export function createAiProvider(
  key: string,
  options: OllamaProviderOptions = {},
): AiProvider | null {
  if (key !== "ollama") return null;
  return new OllamaProvider(options);
}
