import type { AnyGraph } from "../graph";
import type { LLMProvider, ProviderInfo } from "../types";
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL, type Effort } from "./anthropic";
import { MockProvider } from "./mock";
import { OpenAICompatibleProvider } from "./openai-compatible";

export { AnthropicProvider, MockProvider, OpenAICompatibleProvider };

type Env = Record<string, string | undefined>;

/** Which providers can be used, based on environment variables. */
export function listProviders(env: Env = process.env): ProviderInfo[] {
  return [
    {
      id: "mock",
      label: "Mock (scripted, offline)",
      model: "mock-1",
      configured: true,
      hint: "No API key needed. Each graph ships scripted replies.",
    },
    {
      id: "anthropic",
      label: "Claude (Anthropic)",
      model: env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
      configured: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
      hint: "Set ANTHROPIC_API_KEY (or run `ant auth login`). Optional: ANTHROPIC_MODEL, ANTHROPIC_EFFORT.",
    },
    {
      id: "openai-compatible",
      label: env.OPENAI_LABEL ?? "OpenAI-compatible",
      model: env.OPENAI_MODEL ?? "(set OPENAI_MODEL)",
      configured: Boolean(env.OPENAI_MODEL),
      hint: "Set OPENAI_MODEL, plus OPENAI_BASE_URL (default https://api.openai.com/v1) and OPENAI_API_KEY. Works with Ollama, vLLM, LM Studio.",
    },
  ];
}

/** Create a fresh provider instance for one run. */
export function createProvider(id: string, graph: AnyGraph, env: Env = process.env): LLMProvider {
  switch (id) {
    case "mock":
      return new MockProvider(graph.mockScripts ?? {});
    case "anthropic":
      return new AnthropicProvider({
        model: env.ANTHROPIC_MODEL,
        effort: env.ANTHROPIC_EFFORT as Effort | undefined,
      });
    case "openai-compatible":
      if (!env.OPENAI_MODEL) throw new Error("OPENAI_MODEL is not set");
      return new OpenAICompatibleProvider({
        baseURL: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        apiKey: env.OPENAI_API_KEY,
        model: env.OPENAI_MODEL,
        label: env.OPENAI_LABEL,
      });
    default:
      throw new Error(`Unknown provider "${id}"`);
  }
}
