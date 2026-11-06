import { END, type BaseState, type GraphDefinition, type MockReply } from "../graph";
import { executeToolCalls, functionNode, parseList } from "../nodes";
import { builtinTools } from "../tools";
import type { ChatMessage, LLMRequest } from "../types";
import { answerFromToolResults, firstUserText, guessToolCalls, lastMessage } from "./mock-helpers";

export interface PlanState extends BaseState {
  goal: string;
  plan: string[];
  current: number;
  results: { step: string; result: string }[];
  /** Working conversation for the step being executed; reset for each step. */
  scratch: ChatMessage[];
}

const toolSpecs = builtinTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

/**
 * Plan-and-execute:
 *
 *   start -> planner -> executor --(tool calls)--> exec_tools -> executor
 *                          |--(step done)--> record --(more steps)--> executor
 *                                                   --(plan done)--> synthesizer -> end
 *
 * Two nested loops: the inner executor <-> exec_tools loop finishes ONE step;
 * the outer record -> executor loop walks the plan. The plan lives in state, so
 * you can watch `current` advance in the inspector.
 */
export const planExecute: GraphDefinition<PlanState> = {
  id: "plan-execute",
  name: "Plan & execute",
  description:
    "Planning pattern: a planner writes a step list, an executor completes each step with tools (inner loop), and a recorder advances the plan (outer loop). A synthesizer writes the answer.",
  entry: "planner",
  maxSteps: 30,
  nodes: [
    functionNode<PlanState>({
      id: "planner",
      kind: "llm",
      label: "planner",
      description: "Breaks the goal into 2-4 numbered steps.",
      async run(state, ctx) {
        const res = await ctx.callLLM({
          system: `You are a planner. Break the user's goal into 2-4 short, concrete steps that can each be done with these tools: ${builtinTools.map((t) => t.name).join(", ")} (or by reasoning alone). Output only a numbered list, one step per line.`,
          messages: [{ role: "user", text: state.goal }],
          tools: [],
        });
        const plan = parseList(res.text).slice(0, 6);
        if (plan.length === 0) throw new Error(`Planner returned no steps: ${res.text}`);
        return { plan, current: 0, scratch: [] };
      },
    }),
    functionNode<PlanState>({
      id: "executor",
      kind: "llm",
      label: "executor",
      description: "Works on the current step only, calling tools if needed.",
      async run(state, ctx) {
        const step = state.plan[state.current] ?? "";
        const done = state.results.map((r, i) => `${i + 1}. ${r.step} -> ${r.result}`).join("\n") || "(nothing yet)";
        const scratch: ChatMessage[] = state.scratch.length
          ? state.scratch
          : [{ role: "user", text: `Overall goal: ${state.goal}\n\nCompleted steps:\n${done}\n\nCurrent step: ${step}\n\nDo only the current step. Use tools when they help, then reply with the step's result in one or two sentences.` }];
        const res = await ctx.callLLM({
          system: "You are an executor. Complete exactly one step of a plan. Always use the calculator for arithmetic.",
          messages: scratch,
          tools: toolSpecs,
        });
        return {
          scratch: [...scratch, { role: "assistant", text: res.text, toolCalls: res.toolCalls, reasoning: res.reasoning, raw: res.raw }],
        };
      },
    }),
    functionNode<PlanState>({
      id: "exec_tools",
      kind: "tool",
      label: "tools",
      description: "Runs the executor's tool calls and adds the results to the step's scratch conversation.",
      async run(state, ctx) {
        const last = state.scratch.at(-1);
        const calls = last?.role === "assistant" ? last.toolCalls : [];
        const results = await executeToolCalls(calls, builtinTools, ctx);
        return { scratch: [...state.scratch, { role: "tool", results }] };
      },
    }),
    functionNode<PlanState>({
      id: "record",
      label: "record",
      description: "Saves the step's result, advances `current`, clears the scratch.",
      run(state) {
        const last = state.scratch.at(-1);
        const result = last?.role === "assistant" ? last.text : "";
        const step = state.plan[state.current] ?? "";
        return { results: [...state.results, { step, result }], current: state.current + 1, scratch: [] };
      },
    }),
    functionNode<PlanState>({
      id: "synthesizer",
      kind: "llm",
      label: "synthesizer",
      description: "Writes the final answer from all step results.",
      async run(state, ctx) {
        const res = await ctx.callLLM({
          system: "Write the final answer for the user from the completed plan. Be brief.",
          messages: [
            {
              role: "user",
              text: `Goal: ${state.goal}\n\nStep results:\n${state.results.map((r, i) => `${i + 1}. ${r.step}: ${r.result}`).join("\n")}`,
            },
          ],
          tools: [],
        });
        return { messages: [{ role: "assistant", text: res.text, toolCalls: [] }] };
      },
    }),
  ],
  edges: [
    { from: "planner", to: "executor", label: "plan" },
    {
      from: "executor",
      targets: ["exec_tools", "record"],
      label: "tool calls?",
      branchLabels: { exec_tools: "use tools", record: "step done" },
      route: (s) => {
        const last = s.scratch.at(-1);
        return last?.role === "assistant" && last.toolCalls.length
          ? { to: "exec_tools", reason: `step ${s.current + 1} needs ${last.toolCalls.map((c) => c.name).join(", ")}` }
          : { to: "record", reason: `step ${s.current + 1} finished` };
      },
    },
    { from: "exec_tools", to: "executor", label: "observe" },
    {
      from: "record",
      targets: ["executor", "synthesizer"],
      label: "more steps?",
      branchLabels: { executor: "next step", synthesizer: "plan done" },
      route: (s) =>
        s.current < s.plan.length
          ? { to: "executor", reason: `step ${s.current + 1} of ${s.plan.length}: ${s.plan[s.current]}` }
          : { to: "synthesizer", reason: `all ${s.plan.length} steps done` },
    },
    { from: "synthesizer", to: END },
  ],
  initialState: (input) => ({
    messages: [{ role: "user", text: input }],
    goal: input,
    plan: [],
    current: 0,
    results: [],
    scratch: [],
  }),
  exampleInputs: [
    "Compute 3 * 1299.99 + 2 * 249.5, then add 8% tax by multiplying the result by 1.08, then tell me the current time.",
    "Look up the ReAct pattern, then look up reflection, then compare them in one sentence.",
  ],
  mockScripts: {
    planner: (req: LLMRequest): MockReply => {
      const steps = firstUserText(req)
        .split(/,?\s*then\s+|;\s*/i)
        .map((s) => s.trim().replace(/[.]$/, ""))
        .filter(Boolean);
      return {
        reasoning: "The goal already lists its steps in order; keep them as-is.",
        text: steps.map((s, i) => `${i + 1}. ${s.charAt(0).toUpperCase()}${s.slice(1)}`).join("\n"),
      };
    },
    executor: (req: LLMRequest): MockReply => {
      const fromTools = answerFromToolResults(req);
      if (fromTools) return fromTools;
      const prompt = lastMessage(req)?.role === "user" ? firstUserText(req) : "";
      const step = prompt.match(/Current step: (.*)/)?.[1] ?? "";
      const completed = prompt.match(/Completed steps:\n([\s\S]*?)\n\nCurrent step/)?.[1] ?? "";
      // "multiply the result by 1.08" -> use the previous step's number.
      const previous = [...completed.matchAll(/-> ([\d.]+)/g)].at(-1)?.[1];
      if (/the result/i.test(step) && previous) {
        const factor = step.match(/by ([\d.]+)/)?.[1] ?? "1";
        return { text: "", toolCalls: [{ name: "calculator", input: { expression: `${previous} * ${factor}` } }] };
      }
      const calls = guessToolCalls(step);
      if (calls.length) return { reasoning: `This step needs ${calls[0]?.name}.`, text: "", toolCalls: calls };
      return {
        reasoning: "No tool needed; reason from the completed steps.",
        text: `Based on the earlier steps: ${completed.replace(/\n/g, " ").slice(0, 200)}`,
      };
    },
    synthesizer: (req: LLMRequest): MockReply => ({
      text: `Done. ${firstUserText(req).split("Step results:")[1]?.trim().replace(/\n/g, " | ") ?? ""}`,
    }),
  },
};
