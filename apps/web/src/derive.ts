import type { GraphDescription, TraceEvent } from "./api";

export interface RunView {
  status: "idle" | "running" | "paused" | "completed" | "max_steps" | "error" | "cancelled";
  /** Node currently executing. */
  activeNode?: string;
  /** Node the run is paused in front of (step mode). */
  pausedNode?: string;
  visits: Record<string, number>;
  /** key `${from}->${to}` */
  edgeCounts: Record<string, number>;
  lastEdge?: string;
  steps: number;
  llmCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  error?: string;
}

export const edgeKey = (from: string, to: string) => `${from}->${to}`;

/**
 * Rebuild everything the UI shows from the event log, up to `upTo` (inclusive).
 * Moving `upTo` backwards is what gives time-travel.
 */
export function deriveView(events: TraceEvent[], upTo = events.length - 1): RunView {
  const v: RunView = {
    status: events.length ? "running" : "idle",
    visits: {},
    edgeCounts: {},
    steps: 0,
    llmCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    elapsedMs: 0,
  };
  const first = events[0];
  for (let i = 0; i <= upTo && i < events.length; i++) {
    const e = events[i]!;
    if (first) v.elapsedMs = e.ts - first.ts;
    switch (e.type) {
      case "paused":
        v.status = "paused";
        v.pausedNode = e.nextNode;
        v.activeNode = undefined;
        break;
      case "node_start":
        v.status = "running";
        v.pausedNode = undefined;
        v.activeNode = e.node;
        v.visits[e.node] = (v.visits[e.node] ?? 0) + 1;
        break;
      case "node_end":
        v.activeNode = undefined;
        v.steps = e.step + 1;
        break;
      case "llm_response":
        v.llmCalls += 1;
        v.inputTokens += e.response.usage?.inputTokens ?? 0;
        v.outputTokens += e.response.usage?.outputTokens ?? 0;
        break;
      case "tool_call":
        v.toolCalls += 1;
        break;
      case "edge": {
        const k = edgeKey(e.from, e.to);
        v.edgeCounts[k] = (v.edgeCounts[k] ?? 0) + 1;
        v.lastEdge = k;
        if (e.to === "__end__") v.visits.__end__ = 1;
        break;
      }
      case "run_end":
        v.status = e.status;
        v.activeNode = undefined;
        v.pausedNode = undefined;
        v.error = e.error;
        v.elapsedMs = e.durationMs;
        break;
    }
  }
  if (first) v.visits.__start__ = 1;
  return v;
}

/** Layered layout: BFS depth from start, END pinned to the bottom. */
export function layout(graph: GraphDescription) {
  const depth = new Map<string, number>([["__start__", 0]]);
  const queue = ["__start__"];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of graph.edges) {
      if (e.from !== id || depth.has(e.to) || e.to === "__end__") continue;
      depth.set(e.to, depth.get(id)! + 1);
      queue.push(e.to);
    }
  }
  const maxDepth = Math.max(0, ...depth.values());
  for (const n of graph.nodes) {
    if (n.id === "__end__") depth.set(n.id, maxDepth + 1);
    else if (!depth.has(n.id)) depth.set(n.id, maxDepth + 1);
  }
  const rows = new Map<number, string[]>();
  for (const n of graph.nodes) {
    const d = depth.get(n.id)!;
    rows.set(d, [...(rows.get(d) ?? []), n.id]);
  }
  const positions: Record<string, { x: number; y: number }> = {};
  const colWidth = 220;
  const rowHeight = 130;
  for (const [d, ids] of rows) {
    ids.forEach((id, i) => {
      positions[id] = { x: (i - (ids.length - 1) / 2) * colWidth, y: d * rowHeight };
    });
  }
  return { positions, depth };
}
