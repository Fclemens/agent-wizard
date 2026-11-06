import { END, type BaseState, type GraphDefinition, type MockReply } from "../graph";
import { functionNode, runSubagent } from "../nodes";
import { calculatorTool, searchNotesTool } from "../tools";
import type { LLMRequest } from "../types";
import { answerFromToolResults, firstUserText, guessToolCalls, lastMessage } from "./mock-helpers";

const WORKERS = {
  researcher: {
    description: "explains agent-design concepts using the search_notes tool",
    system: "You are a researcher. Use search_notes to look up concepts, then summarize what you found in 1-2 sentences.",
    tools: [searchNotesTool],
  },
  mathematician: {
    description: "does arithmetic precisely using the calculator tool",
    system: "You are a mathematician. Always use the calculator, then state the result in one sentence.",
    tools: [calculatorTool],
  },
} as const;
type Worker = keyof typeof WORKERS;
const MAX_DELEGATIONS = 5;

export interface SupervisorState extends BaseState {
  task: string;
  work: { worker: Worker; instruction: string; output: string }[];
  next: Worker | "FINISH" | "";
  instruction: string;
}

function workerNode(worker: Worker) {
  return functionNode<SupervisorState>({
    id: worker,
    kind: "llm",
    label: worker,
    description: `Sub-agent (its own tool loop inside this node) that ${WORKERS[worker].description}.`,
    async run(state, ctx) {
      const { text } = await runSubagent(ctx, {
        system: WORKERS[worker].system,
        task: state.instruction,
        tools: [...WORKERS[worker].tools],
      });
      return { work: [...state.work, { worker, instruction: state.instruction, output: text }] };
    },
  });
}

/**
 * Supervisor / multi-agent:
 *
 *   start -> supervisor --(researcher)--> researcher ----> supervisor
 *                       --(mathematician)--> mathematician -> supervisor
 *                       --(FINISH)--> writer -> end
 *
 * The supervisor is a router driven by an LLM: each turn it reads the work
 * done so far and delegates the next piece. Each worker is a full agent loop
 * packed into one node (see runSubagent), so the outer graph stays readable.
 */
export const supervisorTeam: GraphDefinition<SupervisorState> = {
  id: "supervisor",
  name: "Supervisor team",
  description:
    "Multi-agent pattern: an LLM supervisor delegates to specialist sub-agents (each with its own tools and inner loop) until it decides the task is done, then a writer answers.",
  entry: "supervisor",
  maxSteps: 14,
  nodes: [
    functionNode<SupervisorState>({
      id: "supervisor",
      kind: "llm",
      label: "supervisor",
      description: "Chooses which worker acts next (or FINISH) and writes its instruction.",
      async run(state, ctx) {
        const team = Object.entries(WORKERS).map(([name, w]) => `- ${name}: ${w.description}`).join("\n");
        const work = state.work.map((w, i) => `${i + 1}. ${w.worker} (${w.instruction}): ${w.output}`).join("\n") || "(none yet)";
        const res = await ctx.callLLM({
          system: `You supervise a team:\n${team}\n\nDelegate one sub-task at a time. Reply in exactly this format:\nNEXT: <researcher|mathematician|FINISH>\nINSTRUCTION: <what that worker should do, or empty for FINISH>\nChoose FINISH as soon as the work so far fully answers the task.`,
          messages: [{ role: "user", text: `Task: ${state.task}\n\nWork so far:\n${work}` }],
          tools: [],
        });
        const nextRaw = res.text.match(/NEXT:\s*(\w+)/i)?.[1]?.toLowerCase() ?? "finish";
        const next: SupervisorState["next"] = nextRaw in WORKERS ? (nextRaw as Worker) : "FINISH";
        const instruction = res.text.match(/INSTRUCTION:\s*(.*)/i)?.[1]?.trim() || state.task;
        return { next, instruction };
      },
    }),
    workerNode("researcher"),
    workerNode("mathematician"),
    functionNode<SupervisorState>({
      id: "writer",
      kind: "llm",
      label: "writer",
      description: "Combines the workers' outputs into the final answer.",
      async run(state, ctx) {
        const res = await ctx.callLLM({
          system: "Write the final answer to the task using the team's findings. Be concise.",
          messages: [
            { role: "user", text: `Task: ${state.task}\n\nFindings:\n${state.work.map((w) => `- ${w.worker}: ${w.output}`).join("\n")}` },
          ],
          tools: [],
        });
        return { messages: [{ role: "assistant", text: res.text, toolCalls: [] }] };
      },
    }),
  ],
  edges: [
    {
      from: "supervisor",
      targets: ["researcher", "mathematician", "writer"],
      label: "delegate",
      branchLabels: { researcher: "research", mathematician: "math", writer: "FINISH" },
      route: (s) =>
        s.work.length >= MAX_DELEGATIONS
          ? { to: "writer", reason: `delegation limit (${MAX_DELEGATIONS}) reached` }
          : s.next === "FINISH" || !s.next
            ? { to: "writer", reason: "supervisor decided the task is complete" }
            : { to: s.next, reason: `supervisor delegated: ${s.instruction}` },
    },
    { from: "researcher", to: "supervisor", label: "report" },
    { from: "mathematician", to: "supervisor", label: "report" },
    { from: "writer", to: END },
  ],
  initialState: (input) => ({ messages: [{ role: "user", text: input }], task: input, work: [], next: "", instruction: "" }),
  exampleInputs: [
    "Explain what a state graph is, and compute 15% of 2400 (that is, 2400 * 0.15).",
    "What is reflection in agent design, and what is (365 * 24) - 100?",
  ],
  mockScripts: {
    supervisor: (req: LLMRequest): MockReply => {
      const text = firstUserText(req);
      const task = text.match(/Task: (.*)/)?.[1] ?? "";
      const did = (w: string) => new RegExp(`\\d+\\. ${w} `).test(text);
      const calls = guessToolCalls(task);
      const topic = calls.find((c) => c.name === "search_notes");
      const math = calls.find((c) => c.name === "calculator");
      if (topic && !did("researcher")) {
        return { reasoning: "Start with the concept question.", text: `NEXT: researcher\nINSTRUCTION: Explain "${String(topic.input.query)}"` };
      }
      if (math && !did("mathematician")) {
        return { reasoning: "Concept covered; now the arithmetic.", text: `NEXT: mathematician\nINSTRUCTION: Compute ${String(math.input.expression)}` };
      }
      return { reasoning: "Both parts are answered.", text: "NEXT: FINISH\nINSTRUCTION:" };
    },
    researcher: (req: LLMRequest): MockReply => {
      const done = answerFromToolResults(req);
      if (done) return done;
      const query = firstUserText(req).match(/"(.+)"/)?.[1] ?? firstUserText(req);
      return { text: "", toolCalls: [{ name: "search_notes", input: { query } }] };
    },
    mathematician: (req: LLMRequest): MockReply => {
      if (lastMessage(req)?.role === "tool") {
        const r = answerFromToolResults(req);
        return { text: `The result is ${r?.text}.` };
      }
      const expression = firstUserText(req).replace(/^Compute\s*/i, "");
      return { text: "", toolCalls: [{ name: "calculator", input: { expression } }] };
    },
    writer: (req: LLMRequest): MockReply => ({
      text: firstUserText(req).split("Findings:")[1]?.trim() ?? "",
    }),
  },
};
