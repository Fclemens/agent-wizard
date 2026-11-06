import type { MockScript } from "../graph";
import type { LLMProvider, LLMRequest, LLMResponse } from "../types";

/**
 * A scripted stand-in for an LLM. Each graph node can ship a script that
 * decides what the "model" says given the exact request a real model would
 * get. Lets you study loop mechanics offline, deterministically, for free.
 */
export class MockProvider implements LLMProvider {
  readonly id = "mock";
  readonly label = "Mock (scripted, offline)";
  readonly model = "mock-1";
  private turns = new Map<string, number>();
  private callCounter = 0;

  constructor(
    private scripts: Record<string, MockScript>,
    private opts: { latencyMs?: [number, number] } = {},
  ) {}

  async complete(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    const [min, max] = this.opts.latencyMs ?? [250, 700];
    await sleep(min + Math.random() * (max - min), signal);

    const script = this.scripts[req.nodeId];
    const turn = this.turns.get(req.nodeId) ?? 0;
    this.turns.set(req.nodeId, turn + 1);
    const reply = script
      ? script(req, turn)
      : { text: `(mock) No script for node "${req.nodeId}". Add one to the graph's mockScripts.` };

    const toolCalls = (reply.toolCalls ?? []).map((c) => ({ ...c, id: `mock_call_${++this.callCounter}` }));
    const text = reply.text ?? "";
    return {
      model: this.model,
      text,
      toolCalls,
      reasoning: reply.reasoning,
      stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
      usage: { inputTokens: estimateTokens(JSON.stringify(req)), outputTokens: estimateTokens(text) + 10 * toolCalls.length },
    };
  }
}

function estimateTokens(s: string) {
  return Math.ceil(s.length / 4);
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
