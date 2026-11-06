import type { ChatMessage, LLMProvider, LLMRequest, LLMResponse } from "../types";

export interface OpenAICompatibleOptions {
  /** e.g. https://api.openai.com/v1, http://localhost:11434/v1 (Ollama), any OpenAI-compatible server. */
  baseURL: string;
  model: string;
  apiKey?: string;
  label?: string;
}

/**
 * Any server that speaks the OpenAI Chat Completions format: OpenAI itself,
 * Ollama, vLLM, LM Studio, OpenRouter, and so on. Plain fetch, no SDK, so the
 * wire format is easy to read.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly id = "openai-compatible";
  readonly label: string;
  readonly model: string;

  constructor(private opts: OpenAICompatibleOptions) {
    this.model = opts.model;
    this.label = opts.label ?? "OpenAI-compatible";
  }

  async complete(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    const body = {
      model: this.model,
      messages: toChatMessages(req),
      ...(req.tools.length
        ? {
            tools: req.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
    };
    const res = await fetch(`${this.opts.baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`${this.label} returned HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as ChatCompletion;
    const choice = data.choices[0];
    if (!choice) throw new Error(`${this.label} returned no choices`);

    const toolCalls = (choice.message.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function.name,
      input: parseArgs(c.function.arguments),
    }));
    const finish = choice.finish_reason;
    return {
      model: data.model ?? this.model,
      text: choice.message.content ?? "",
      toolCalls: finish === "length" ? [] : toolCalls,
      stopReason: finish === "tool_calls" ? "tool_use" : finish === "length" ? "max_tokens" : finish === "stop" ? "end_turn" : finish,
      usage: data.usage
        ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
        : undefined,
      raw: { provider: this.id, content: choice.message },
    };
  }
}

interface ChatCompletion {
  model?: string;
  choices: {
    finish_reason: string;
    message: {
      content: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

function parseArgs(args: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(args || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return { _unparseable_arguments: args };
  }
}

function toChatMessages(req: LLMRequest): unknown[] {
  const out: unknown[] = [];
  if (req.system) out.push({ role: "system", content: req.system });
  for (const m of req.messages as ChatMessage[]) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.text || null,
        ...(m.toolCalls.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.input) },
              })),
            }
          : {}),
      });
    } else {
      for (const r of m.results) out.push({ role: "tool", tool_call_id: r.toolCallId, content: r.output });
    }
  }
  return out;
}
