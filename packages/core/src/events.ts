import type { LLMRequest, LLMResponse, ToolCall, ToolResult, Usage } from "./types";

/**
 * Everything the engine does is recorded as a TraceEvent. The UI (and any
 * other consumer) reconstructs the whole run from this stream alone, which
 * is what makes replay and time-travel inspection possible.
 */
export type TraceEventBody =
  | {
      type: "run_start";
      graphId: string;
      input: string;
      provider: string;
      model: string;
      initialState: unknown;
    }
  | { type: "paused"; nextNode: string }
  | { type: "node_start"; node: string; state: unknown }
  | { type: "llm_request"; node: string; request: LLMRequest }
  | { type: "llm_response"; node: string; response: LLMResponse; durationMs: number }
  | { type: "tool_call"; node: string; call: ToolCall }
  | { type: "tool_result"; node: string; result: ToolResult; durationMs: number }
  | { type: "log"; node: string; message: string }
  | { type: "node_end"; node: string; update: unknown; durationMs: number }
  | { type: "edge"; from: string; to: string; reason: string }
  | {
      type: "run_end";
      status: RunStatus;
      error?: string;
      finalState: unknown;
      steps: number;
      usage: Usage;
      durationMs: number;
    };

export type RunStatus = "completed" | "max_steps" | "error" | "cancelled";

export type TraceEvent = TraceEventBody & {
  runId: string;
  /** Monotonic index within the run. */
  seq: number;
  /** Epoch milliseconds. */
  ts: number;
  /** Graph step (one node execution = one step). */
  step: number;
};

export type TraceEventType = TraceEvent["type"];
