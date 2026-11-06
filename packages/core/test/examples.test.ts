import { describe, expect, it } from "vitest";
import {
  type AnyGraph,
  MockProvider,
  type TraceEvent,
  checkPolicy,
  describeGraph,
  exampleGraphs,
  extractJson,
  guardrails,
  intentRouter,
  parseList,
  planExecute,
  promptChain,
  runGraph,
  supervisorTeam,
  validateContact,
  validatedExtraction,
} from "../src/index";

const run = (graph: AnyGraph, input: string) =>
  runGraph<any>(graph, { provider: new MockProvider(graph.mockScripts ?? {}, { latencyMs: [0, 0] }), input });
const path = (events: TraceEvent[]) => events.flatMap((e) => (e.type === "node_start" ? [e.node] : []));
const toolResults = (events: TraceEvent[]) => events.flatMap((e) => (e.type === "tool_result" ? [e.result] : []));

describe("every example graph", () => {
  for (const graph of exampleGraphs) {
    it(`${graph.id}: is valid and completes every example input on the mock provider`, async () => {
      expect(() => describeGraph(graph)).not.toThrow();
      for (const input of graph.exampleInputs ?? []) {
        const res = await run(graph, input);
        expect(res.status, `${graph.id} / ${input}: ${res.error}`).toBe("completed");
      }
    });
  }
});

describe("intent-router", () => {
  it("routes each message to one specialist without looping", async () => {
    const cases: [string, string][] = [
      ["I was charged twice for my subscription this month.", "billing_agent"],
      ["The app crashes whenever I upload a file.", "tech_agent"],
      ["What are your support hours?", "general_agent"],
    ];
    for (const [input, specialist] of cases) {
      expect(path((await run(intentRouter, input)).events)).toEqual(["classify", specialist]);
    }
  });
});

describe("prompt-chain", () => {
  it("sends a bad outline back through the gate, then continues the chain", async () => {
    const res = await run(promptChain, "Announce dark mode.");
    expect(path(res.events)).toEqual(["outline", "gate", "outline", "gate", "draft", "polish"]);
    expect(res.state.outlineAttempts).toBe(2);
    expect(res.state.final).toMatch(/Dark mode/);
  });
});

describe("plan-execute", () => {
  it("walks the plan with an inner tool loop per step", async () => {
    const res = await run(planExecute, planExecute.exampleInputs![0]!);
    expect(res.state.plan).toHaveLength(3);
    expect(res.state.results).toHaveLength(3);
    const outputs = toolResults(res.events).map((r) => r.output);
    expect(outputs[0]).toBe("4398.97");
    expect(Number(outputs[1])).toBeCloseTo(4398.97 * 1.08, 6);
    expect(path(res.events)).toEqual([
      "planner",
      "executor", "exec_tools", "executor", "record",
      "executor", "exec_tools", "executor", "record",
      "executor", "exec_tools", "executor", "record",
      "synthesizer",
    ]);
  });
});

describe("supervisor", () => {
  it("delegates to each specialist once, then finishes", async () => {
    const res = await run(supervisorTeam, supervisorTeam.exampleInputs![0]!);
    expect(path(res.events)).toEqual(["supervisor", "researcher", "supervisor", "mathematician", "supervisor", "writer"]);
    expect(toolResults(res.events).map((r) => r.output)).toContain("360");
  });
});

describe("guardrails", () => {
  it("blocks unsafe calls, explains why, and lets the agent adapt", async () => {
    const res = await run(guardrails, guardrails.exampleInputs![0]!);
    expect(path(res.events)).toEqual(["agent", "guard", "reject", "agent", "guard", "tools", "agent"]);
    const executed = toolResults(res.events).map((r) => r.output);
    expect(executed).toEqual([expect.stringContaining("team@example.com")]);
  });
  it("policy rules", () => {
    expect(checkPolicy({ id: "1", name: "delete_records", input: { table: "x" } })).toBeTruthy();
    expect(checkPolicy({ id: "1", name: "send_email", input: { to: "a@gmail.com" } })).toBeTruthy();
    expect(checkPolicy({ id: "1", name: "send_email", input: { to: "a@example.com" } })).toBeUndefined();
  });
});

describe("validated-extraction", () => {
  it("feeds validation errors back until the JSON passes", async () => {
    const res = await run(validatedExtraction, validatedExtraction.exampleInputs![0]!);
    expect(path(res.events)).toEqual(["extract", "validate", "extract", "validate"]);
    expect(res.state.extracted).toMatchObject({ meeting_date: "2026-03-05", attendees: 5 });
    const feedback = res.state.messages.find((m: { role: string; text?: string }) => m.role === "user" && m.text?.includes("failed validation"));
    expect(feedback?.text).toMatch(/meeting_date/);
    expect(feedback?.text).toMatch(/attendees/);
  });
  it("validator rules", () => {
    expect(validateContact({ name: "A", email: "a@b.co", company: "C", meeting_date: "2026-01-02", attendees: 2 })).toEqual([]);
    expect(validateContact({ name: "A" })).toHaveLength(4);
  });
});

describe("parsing helpers", () => {
  it("parseList handles numbers and bullets", () => {
    expect(parseList("Plan:\n1. a\n2) b\n- c\n* d\nnot a step")).toEqual(["a", "b", "c", "d"]);
  });
  it("extractJson handles fences and prose", () => {
    expect(extractJson('Sure!\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Result: {"a": {"b": 2}} done')).toEqual({ a: { b: 2 } });
    expect(() => extractJson("nothing here")).toThrow();
  });
});
