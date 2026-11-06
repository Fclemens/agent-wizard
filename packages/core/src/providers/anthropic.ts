import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, LLMProvider, LLMRequest, LLMResponse, ToolCall } from "../types";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicProviderOptions {
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  /** Server-side refusal fallback (routes declined requests to another model). Default on. */
  fallbacks?: boolean;
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/**
 * Claude via the official Anthropic SDK.
 *
 * - Adaptive thinking with summarized display, so the trace shows the model's
 *   reasoning summary for each turn.
 * - Assistant turns are replayed from their raw content blocks so thinking
 *   blocks go back to the API unchanged, as required.
 */
export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic";
  readonly label = "Claude (Anthropic)";
  readonly model: string;
  private client: Anthropic;
  private effort: Effort;
  private maxTokens: number;
  private fallbacks: boolean;

  constructor(opts: AnthropicProviderOptions = {}) {
    // Resolves credentials from ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login`.
    this.client = new Anthropic();
    this.model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.effort = opts.effort ?? "medium";
    this.maxTokens = opts.maxTokens ?? 64000;
    this.fallbacks = opts.fallbacks ?? true;
  }

  async complete(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    const params = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: req.system,
      messages: toAnthropicMessages(req.messages),
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      })),
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: this.effort },
      ...(this.fallbacks
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }
        : {}),
    } as Anthropic.Beta.MessageCreateParamsStreaming;

    const stream = this.client.beta.messages.stream(params, { signal });
    const message = await stream.finalMessage();

    let text = "";
    let reasoning = "";
    const toolCalls: ToolCall[] = [];
    for (const block of message.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "thinking") reasoning += block.thinking;
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
      }
    }

    // Never run tools from a turn that was cut off or declined.
    const stopReason = message.stop_reason ?? "end_turn";
    const safeToolCalls = stopReason === "max_tokens" || stopReason === "refusal" ? [] : toolCalls;
    if (stopReason === "refusal" && !text) text = "[The model declined this request.]";

    return {
      model: message.model,
      text,
      toolCalls: safeToolCalls,
      reasoning: reasoning || undefined,
      stopReason,
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
      raw: { provider: this.id, content: message.content },
    };
  }
}

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((m): Anthropic.Beta.BetaMessageParam => {
    switch (m.role) {
      case "user":
        return { role: "user", content: m.text };
      case "assistant": {
        if (m.raw?.provider === "anthropic") {
          return { role: "assistant", content: m.raw.content as Anthropic.Beta.BetaContentBlockParam[] };
        }
        const content: Anthropic.Beta.BetaContentBlockParam[] = [];
        if (m.text) content.push({ type: "text", text: m.text });
        for (const c of m.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
        return { role: "assistant", content };
      }
      case "tool":
        return {
          role: "user",
          content: m.results.map((r) => ({
            type: "tool_result" as const,
            tool_use_id: r.toolCallId,
            content: r.output,
            is_error: r.isError,
          })),
        };
    }
  });
}
