/**
 * Provider-neutral types shared by the engine, providers, and the UI.
 *
 * Every LLM provider converts to and from these shapes, so graphs never
 * depend on a specific vendor's message format.
 */

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  output: string;
  isError?: boolean;
}

/**
 * Opaque provider-native content kept on assistant messages so a provider can
 * replay its own turns exactly (e.g. Claude thinking blocks must be passed back
 * unchanged). Other providers ignore it and rebuild from text + toolCalls.
 */
export interface ProviderRaw {
  provider: string;
  content: unknown;
}

export type ChatMessage =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      toolCalls: ToolCall[];
      reasoning?: string;
      raw?: ProviderRaw;
    }
  | { role: "tool"; results: ToolResult[] };

/** JSON Schema for a tool's input (kept loose on purpose). */
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
}

export interface Tool extends ToolSpec {
  run(input: Record<string, unknown>): Promise<string> | string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMRequest {
  /** Which graph node is asking. Used by the mock provider to pick a script. */
  nodeId: string;
  system?: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
}

export interface LLMResponse {
  model: string;
  text: string;
  toolCalls: ToolCall[];
  /** Summarized reasoning, when the provider exposes it. */
  reasoning?: string;
  /** Normalized: "end_turn" | "tool_use" | "max_tokens" | "refusal" | provider-specific. */
  stopReason: string;
  usage?: Usage;
  raw?: ProviderRaw;
}

export interface LLMProvider {
  id: string;
  label: string;
  model: string;
  complete(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse>;
}

export interface ProviderInfo {
  id: string;
  label: string;
  model: string;
  configured: boolean;
  hint?: string;
}
