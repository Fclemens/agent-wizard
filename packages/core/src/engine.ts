import type { RunStatus, TraceEvent, TraceEventBody } from "./events";
import {
  type AnyGraph,
  type BaseState,
  DEFAULT_MAX_STEPS,
  END,
  type NodeContext,
  START,
  applyUpdate,
  isConditional,
  validateGraph,
} from "./graph";
import type { LLMProvider, Usage } from "./types";

/**
 * Lets an outside caller (the server, a test, a CLI) pause, single-step,
 * resume, or cancel a run. The engine calls `gate()` before every node.
 */
export class RunController {
  readonly abort = new AbortController();
  private stepMode: boolean;
  private release?: () => void;

  constructor(opts: { stepMode?: boolean } = {}) {
    this.stepMode = opts.stepMode ?? false;
  }

  get isStepMode() {
    return this.stepMode;
  }

  get isWaiting() {
    return this.release !== undefined;
  }

  /** Called by the engine before each node. Blocks while in step mode. */
  async gate(onPause: () => void): Promise<void> {
    if (!this.stepMode || this.abort.signal.aborted) return;
    onPause();
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  /** Run exactly one more node, then pause again. */
  step() {
    const release = this.release;
    this.release = undefined;
    release?.();
  }

  pause() {
    this.stepMode = true;
  }

  resume() {
    this.stepMode = false;
    this.step();
  }

  cancel() {
    this.abort.abort();
    this.step();
  }
}

export interface RunOptions {
  provider: LLMProvider;
  input: string;
  runId?: string;
  maxSteps?: number;
  controller?: RunController;
  onEvent?: (event: TraceEvent) => void;
}

export interface RunResult<S extends BaseState = BaseState> {
  runId: string;
  status: RunStatus;
  error?: string;
  state: S;
  steps: number;
  usage: Usage;
  events: TraceEvent[];
}

let runCounter = 0;
export function newRunId(): string {
  runCounter += 1;
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `run_${stamp}_${runCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Execute a graph: start at the entry node, run it, merge its update into
 * state, follow the outgoing edge, repeat until END (or a limit is hit).
 *
 * This loop IS the agentic loop. Cycles in the graph (e.g. agent -> tools ->
 * agent) are what make it iterate; the router on the conditional edge is what
 * makes it stop.
 */
export async function runGraph<S extends BaseState>(
  graph: AnyGraph,
  opts: RunOptions,
): Promise<RunResult<S>> {
  validateGraph(graph);
  const runId = opts.runId ?? newRunId();
  const controller = opts.controller ?? new RunController();
  const signal = controller.abort.signal;
  const maxSteps = opts.maxSteps ?? graph.maxSteps ?? DEFAULT_MAX_STEPS;
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const visits = new Map<string, number>();
  const events: TraceEvent[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const startedAt = Date.now();

  let seq = 0;
  let step = 0;
  const emit = (body: TraceEventBody) => {
    const event = { ...body, runId, seq: seq++, ts: Date.now(), step } as TraceEvent;
    events.push(event);
    opts.onEvent?.(event);
  };

  let state = graph.initialState(opts.input) as S;
  emit({
    type: "run_start",
    graphId: graph.id,
    input: opts.input,
    provider: opts.provider.id,
    model: opts.provider.model,
    initialState: state,
  });
  emit({ type: "edge", from: START, to: graph.entry, reason: "entry point" });

  let current = graph.entry;
  let status: RunStatus = "completed";
  let error: string | undefined;

  try {
    while (current !== END) {
      if (signal.aborted) {
        status = "cancelled";
        break;
      }
      if (step >= maxSteps) {
        status = "max_steps";
        break;
      }
      const nodeId = current;
      await controller.gate(() => emit({ type: "paused", nextNode: nodeId }));
      if (signal.aborted) {
        status = "cancelled";
        break;
      }

      const node = nodes.get(nodeId);
      if (!node) throw new Error(`Unknown node "${nodeId}"`);
      const visit = visits.get(nodeId) ?? 0;
      visits.set(nodeId, visit + 1);

      const ctx: NodeContext = {
        provider: opts.provider,
        signal,
        visit,
        step,
        emit: (e) => emit({ ...e, node: nodeId } as TraceEventBody),
        callLLM: async (request) => {
          const req = { ...request, nodeId };
          emit({ type: "llm_request", node: nodeId, request: req });
          const t0 = Date.now();
          const response = await opts.provider.complete(req, signal);
          if (response.usage) {
            usage.inputTokens += response.usage.inputTokens;
            usage.outputTokens += response.usage.outputTokens;
          }
          emit({ type: "llm_response", node: nodeId, response, durationMs: Date.now() - t0 });
          return response;
        },
      };

      emit({ type: "node_start", node: nodeId, state });
      const t0 = Date.now();
      const update = (await node.run(state, ctx)) ?? undefined;
      state = applyUpdate(state, update);
      emit({ type: "node_end", node: nodeId, update: update ?? {}, durationMs: Date.now() - t0 });

      const { to, reason } = nextNode(graph, nodeId, state);
      emit({ type: "edge", from: nodeId, to, reason });
      current = to;
      step += 1;
    }
  } catch (err) {
    if (signal.aborted) {
      status = "cancelled";
    } else {
      status = "error";
      error = err instanceof Error ? err.message : String(err);
    }
  }

  emit({
    type: "run_end",
    status,
    error,
    finalState: state,
    steps: step,
    usage,
    durationMs: Date.now() - startedAt,
  });

  return { runId, status, error, state, steps: step, usage, events };
}

function nextNode(graph: AnyGraph, from: string, state: BaseState): { to: string; reason: string } {
  const edge = graph.edges.find((e) => e.from === from);
  if (!edge) return { to: END, reason: "no outgoing edge" };
  if (!isConditional(edge)) return { to: edge.to, reason: edge.label ?? "static edge" };
  const routed = edge.route(state);
  const { to, reason } = typeof routed === "string" ? { to: routed, reason: `routed to ${routed}` } : routed;
  if (!edge.targets.includes(to)) {
    throw new Error(`Router on "${from}" returned "${to}", which is not in its declared targets`);
  }
  return { to, reason };
}
