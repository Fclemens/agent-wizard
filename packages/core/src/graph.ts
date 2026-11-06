import type { TraceEventBody } from "./events";
import type { ChatMessage, LLMProvider, LLMRequest, LLMResponse, ToolCall } from "./types";

export const START = "__start__";
export const END = "__end__";

/**
 * Graph state. `messages` is special: updates to it are APPENDED (like a
 * conversation log). Every other key in an update REPLACES the old value.
 */
export interface BaseState {
  messages: ChatMessage[];
}

export type NodeKind = "llm" | "tool" | "router" | "function" | "human";

/** Event bodies a node may emit; the engine fills in node/step/seq/ts. */
type NodeEmittable = TraceEventBody extends infer E
  ? E extends { node: string }
    ? Omit<E, "node">
    : never
  : never;

export interface NodeContext {
  provider: LLMProvider;
  signal: AbortSignal;
  /** Number of times this node has run before in this run (0 on first visit). */
  visit: number;
  step: number;
  emit(event: NodeEmittable): void;
  /** Call the run's LLM provider. Request/response are traced automatically. */
  callLLM(request: Omit<LLMRequest, "nodeId">): Promise<LLMResponse>;
}

export interface GraphNode<S extends BaseState = BaseState> {
  id: string;
  kind: NodeKind;
  label?: string;
  description?: string;
  run(state: S, ctx: NodeContext): Promise<Partial<S> | void> | Partial<S> | void;
}

export interface StaticEdge {
  from: string;
  to: string;
  label?: string;
}

export interface ConditionalEdge<S extends BaseState = BaseState> {
  from: string;
  /** Every node id `route` may return. Declared up front so the graph can be drawn. */
  targets: string[];
  label?: string;
  /** Per-branch labels for the drawing, e.g. { tools: "tool calls", [END]: "final answer" }. */
  branchLabels?: Record<string, string>;
  /** Returns the next node id plus an optional human-readable reason. */
  route(state: S): string | { to: string; reason: string };
}

export type Edge<S extends BaseState = BaseState> = StaticEdge | ConditionalEdge<S>;

export function isConditional<S extends BaseState>(e: Edge<S>): e is ConditionalEdge<S> {
  return "route" in e;
}

/**
 * A mock script plays the LLM for one node so a graph can run offline.
 * It sees exactly what a real model would see.
 */
export type MockScript = (req: LLMRequest, turn: number) => MockReply;
export interface MockReply {
  text?: string;
  toolCalls?: Omit<ToolCall, "id">[];
  reasoning?: string;
}

export interface GraphDefinition<S extends BaseState = BaseState> {
  id: string;
  name: string;
  description: string;
  entry: string;
  nodes: GraphNode<S>[];
  edges: Edge<S>[];
  initialState(input: string): S;
  /** Safety valve against runaway loops. Default 25. */
  maxSteps?: number;
  exampleInputs?: string[];
  /** Scripts keyed by node id, used by the mock provider. */
  mockScripts?: Record<string, MockScript>;
}

/** Serializable shape of a graph, for drawing it in the UI. */
export interface GraphDescription {
  id: string;
  name: string;
  description: string;
  entry: string;
  maxSteps: number;
  exampleInputs: string[];
  nodes: { id: string; kind: NodeKind | "start" | "end"; label: string; description?: string }[];
  edges: { from: string; to: string; label?: string; conditional: boolean }[];
}

// Generic graphs are stored in heterogeneous registries; this alias keeps that ergonomic.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyGraph = GraphDefinition<any>;

export function validateGraph(graph: AnyGraph): void {
  const ids = new Set(graph.nodes.map((n) => n.id));
  if (ids.size !== graph.nodes.length) throw new Error(`Graph ${graph.id}: duplicate node ids`);
  for (const reserved of [START, END]) {
    if (ids.has(reserved)) throw new Error(`Graph ${graph.id}: "${reserved}" is a reserved id`);
  }
  if (!ids.has(graph.entry)) throw new Error(`Graph ${graph.id}: entry "${graph.entry}" is not a node`);
  const known = (id: string) => ids.has(id) || id === END;
  const seenFrom = new Set<string>();
  for (const e of graph.edges) {
    if (!ids.has(e.from)) throw new Error(`Graph ${graph.id}: edge from unknown node "${e.from}"`);
    if (seenFrom.has(e.from)) {
      throw new Error(
        `Graph ${graph.id}: node "${e.from}" has more than one outgoing edge; use a conditional edge to branch`,
      );
    }
    seenFrom.add(e.from);
    const targets = isConditional(e) ? e.targets : [e.to];
    for (const t of targets) {
      if (!known(t)) throw new Error(`Graph ${graph.id}: edge ${e.from} -> unknown node "${t}"`);
    }
  }
}

export function describeGraph(graph: AnyGraph): GraphDescription {
  const nodes: GraphDescription["nodes"] = [
    { id: START, kind: "start", label: "start" },
    ...graph.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      label: n.label ?? n.id,
      description: n.description,
    })),
  ];
  const edges: GraphDescription["edges"] = [{ from: START, to: graph.entry, conditional: false }];
  let usesEnd = false;
  for (const e of graph.edges) {
    const targets = isConditional(e) ? e.targets : [e.to];
    for (const to of targets) {
      if (to === END) usesEnd = true;
      const label = isConditional(e) ? (e.branchLabels?.[to] ?? e.label) : e.label;
      edges.push({ from: e.from, to, label, conditional: isConditional(e) });
    }
  }
  // Nodes without an outgoing edge implicitly go to END.
  for (const n of graph.nodes) {
    if (!graph.edges.some((e) => e.from === n.id)) {
      edges.push({ from: n.id, to: END, conditional: false });
      usesEnd = true;
    }
  }
  if (usesEnd) nodes.push({ id: END, kind: "end", label: "end" });
  return {
    id: graph.id,
    name: graph.name,
    description: graph.description,
    entry: graph.entry,
    maxSteps: graph.maxSteps ?? DEFAULT_MAX_STEPS,
    exampleInputs: graph.exampleInputs ?? [],
    nodes,
    edges,
  };
}

export const DEFAULT_MAX_STEPS = 25;

/** Merge a node's update into state: append `messages`, replace everything else. */
export function applyUpdate<S extends BaseState>(state: S, update: Partial<S> | void): S {
  if (!update) return state;
  const { messages, ...rest } = update;
  return {
    ...state,
    ...rest,
    messages: messages ? [...state.messages, ...messages] : state.messages,
  } as S;
}
