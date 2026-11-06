import { END, type BaseState, type GraphDefinition, type MockReply } from "../graph";
import { llmNode, routeOnToolCalls, toolNode } from "../nodes";
import { NOTES, builtinTools } from "../tools";
import type { LLMRequest } from "../types";

/**
 * The canonical agentic loop:
 *
 *   start -> agent --(tool calls?)--> tools -> agent -> ... --(no tool calls)--> end
 *
 * The cycle agent <-> tools is the loop. The conditional edge out of `agent`
 * decides each iteration whether to keep going.
 */
export const reactAgent: GraphDefinition<BaseState> = {
  id: "react-agent",
  name: "ReAct tool loop",
  description:
    "The classic agent loop: the model either calls tools (and sees their results on the next turn) or answers. Loops until it answers or hits maxSteps.",
  entry: "agent",
  maxSteps: 12,
  nodes: [
    llmNode({
      id: "agent",
      label: "agent",
      description: "Calls the model with the conversation and the available tools.",
      system:
        "You are a helpful assistant inside a teaching harness for agentic loops. Use the provided tools whenever they help: always use the calculator for arithmetic, and search_notes for agent-design concepts. You may call several tools at once. Keep final answers short.",
      tools: builtinTools,
    }),
    toolNode({
      id: "tools",
      label: "tools",
      description: "Executes every tool call from the last model turn and appends the results.",
      tools: builtinTools,
    }),
  ],
  edges: [
    {
      from: "agent",
      targets: ["tools", END],
      label: "tool calls?",
      branchLabels: { tools: "has tool calls", [END]: "final answer" },
      route: routeOnToolCalls("tools"),
    },
    { from: "tools", to: "agent", label: "observe results" },
  ],
  initialState: (input) => ({ messages: [{ role: "user", text: input }] }),
  exampleInputs: [
    "What is (17 * 23) + 4^3, and what is an agentic loop?",
    "What time is it right now (UTC)?",
    "Explain the ReAct pattern, then compute 2^10 / 8.",
    "Tell me about vector databases.",
  ],
  mockScripts: { agent: mockAgent },
};

/** Heuristic stand-in for a model so the loop can be studied offline. */
function mockAgent(req: LLMRequest): MockReply {
  const last = req.messages[req.messages.length - 1];

  if (last?.role === "tool") {
    const lines = last.results.map((r) =>
      r.isError ? `- ${r.name} failed: ${r.output}` : `- ${r.name}: ${r.output}`,
    );
    const anyError = last.results.some((r) => r.isError);
    return {
      reasoning: anyError
        ? "One tool call failed. Rather than retrying blindly, report what I found and what I could not."
        : "I have all the tool results I need; time to answer without calling more tools.",
      text: `Here is what I found:\n${lines.join("\n")}`,
    };
  }

  const question = last?.role === "user" ? last.text : "";
  const lower = question.toLowerCase();
  const calls: MockReply["toolCalls"] = [];

  const math = question.match(/[\d(][\d\s.+\-*/^%()]*[\d)]/g)?.filter((m) => /[+\-*/^%]/.test(m));
  for (const expression of math ?? []) calls.push({ name: "calculator", input: { expression: expression.trim() } });

  if (/\b(time|date|today|now)\b/.test(lower)) calls.push({ name: "get_current_time", input: {} });

  const topics = Object.keys(NOTES).filter((t) => lower.includes(t));
  for (const query of topics) calls.push({ name: "search_notes", input: { query } });
  if (calls.length === 0) {
    const subject = question.replace(/^(tell me about|what is|what are|explain)\s+/i, "").replace(/[?.!]+$/, "");
    calls.push({ name: "search_notes", input: { query: subject } });
  }

  return {
    reasoning: `The question needs ${calls.length} tool call(s): ${calls.map((c) => c.name).join(", ")}. They are independent, so I'll request them in parallel.`,
    text: "Let me look that up.",
    toolCalls: calls,
  };
}
