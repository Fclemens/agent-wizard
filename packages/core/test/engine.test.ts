import { describe, expect, it } from "vitest";
import {
  END,
  MockProvider,
  RunController,
  type GraphDefinition,
  type BaseState,
  describeGraph,
  evaluateArithmetic,
  functionNode,
  reactAgent,
  reflectionLoop,
  runGraph,
  validateGraph,
} from "../src/index";

const fast = (g: { mockScripts?: GraphDefinition["mockScripts"] }) =>
  new MockProvider(g.mockScripts ?? {}, { latencyMs: [0, 0] });

describe("evaluateArithmetic", () => {
  it("respects precedence, parentheses, unary minus and right-assoc powers", () => {
    expect(evaluateArithmetic("(17 * 23) + 4^3")).toBe(455);
    expect(evaluateArithmetic("-2 ^ 2")).toBe(4);
    expect(evaluateArithmetic("2^3^2")).toBe(512);
    expect(evaluateArithmetic("10 % 4 + 1.5")).toBe(3.5);
  });
  it("rejects anything that is not arithmetic", () => {
    expect(() => evaluateArithmetic("process.exit()")).toThrow();
    expect(() => evaluateArithmetic("1/0")).toThrow();
  });
});

describe("react-agent", () => {
  it("loops agent -> tools -> agent and stops when the model stops calling tools", async () => {
    const res = await runGraph(reactAgent, {
      provider: fast(reactAgent),
      input: "What is (17 * 23) + 4^3, and what is an agentic loop?",
    });
    expect(res.status).toBe("completed");
    const path = res.events.filter((e) => e.type === "node_start").map((e) => e.node);
    expect(path).toEqual(["agent", "tools", "agent"]);
    const results = res.events.flatMap((e) => (e.type === "tool_result" ? [e.result] : []));
    expect(results.map((r) => r.name)).toEqual(["calculator", "search_notes"]);
    expect(results[0]?.output).toBe("455");
    const last = res.state.messages.at(-1);
    expect(last?.role).toBe("assistant");
  });

  it("feeds tool errors back to the model instead of crashing", async () => {
    const res = await runGraph(reactAgent, { provider: fast(reactAgent), input: "Tell me about vector databases." });
    expect(res.status).toBe("completed");
    const result = res.events.find((e) => e.type === "tool_result");
    expect(result?.type === "tool_result" && result.result.isError).toBe(true);
  });
});

describe("reflection", () => {
  it("revises until the critic approves", async () => {
    const res = await runGraph<import("../src/index").ReflectionState>(reflectionLoop, {
      provider: fast(reflectionLoop),
      input: "Explain an agentic loop.",
    });
    expect(res.status).toBe("completed");
    expect(res.state.approved).toBe(true);
    expect(res.state.revision).toBe(3);
    const path = res.events.filter((e) => e.type === "node_start").map((e) => e.node);
    expect(path).toEqual(["writer", "critic", "writer", "critic", "writer", "critic"]);
  });
});

describe("engine", () => {
  const looping: GraphDefinition<BaseState & { n: number }> = {
    id: "forever",
    name: "forever",
    description: "never stops",
    entry: "a",
    maxSteps: 5,
    nodes: [functionNode({ id: "a", run: (s) => ({ n: s.n + 1 }) })],
    edges: [{ from: "a", to: "a" }],
    initialState: () => ({ messages: [], n: 0 }),
  };

  it("stops runaway loops at maxSteps", async () => {
    const res = await runGraph<BaseState & { n: number }>(looping, { provider: fast({}), input: "" });
    expect(res.status).toBe("max_steps");
    expect(res.state.n).toBe(5);
  });

  it("supports step mode: pauses before each node until step() is called", async () => {
    const controller = new RunController({ stepMode: true });
    const seen: string[] = [];
    const done = runGraph(looping, {
      provider: fast({}),
      input: "",
      maxSteps: 2,
      controller,
      onEvent: (e) => seen.push(e.type),
    });
    await tick();
    expect(seen.at(-1)).toBe("paused");
    expect(seen.filter((t) => t === "node_start")).toHaveLength(0);
    controller.step();
    await tick();
    expect(seen.filter((t) => t === "node_start")).toHaveLength(1);
    expect(seen.at(-1)).toBe("paused");
    controller.resume();
    const res = await done;
    expect(res.status).toBe("max_steps");
  });

  it("cancels a paused run", async () => {
    const controller = new RunController({ stepMode: true });
    const done = runGraph(looping, { provider: fast({}), input: "", controller });
    await tick();
    controller.cancel();
    expect((await done).status).toBe("cancelled");
  });

  it("rejects a router that returns an undeclared target", async () => {
    const bad: GraphDefinition = {
      id: "bad",
      name: "bad",
      description: "",
      entry: "a",
      nodes: [functionNode({ id: "a", run: () => {} })],
      edges: [{ from: "a", targets: [END], route: () => "nowhere" }],
      initialState: () => ({ messages: [] }),
    };
    const res = await runGraph(bad, { provider: fast({}), input: "" });
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/not in its declared targets/);
  });

  it("validates graph structure", () => {
    expect(() =>
      validateGraph({ ...looping, edges: [{ from: "a", to: "missing" }] } as GraphDefinition),
    ).toThrow(/unknown node/);
  });

  it("describes graphs with start/end nodes and expanded conditional edges", () => {
    const d = describeGraph(reactAgent);
    expect(d.nodes.map((n) => n.id)).toEqual(["__start__", "agent", "tools", "__end__"]);
    expect(d.edges).toContainEqual({ from: "agent", to: "tools", label: "has tool calls", conditional: true });
    expect(d.edges).toContainEqual({ from: "agent", to: "__end__", label: "final answer", conditional: true });
  });
});

function tick() {
  return new Promise((r) => setTimeout(r, 10));
}
