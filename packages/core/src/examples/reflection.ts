import { END, type BaseState, type GraphDefinition, type MockReply } from "../graph";
import { functionNode } from "../nodes";
import type { LLMRequest } from "../types";

export interface ReflectionState extends BaseState {
  task: string;
  draft: string;
  critique: string;
  revision: number;
  approved: boolean;
}

const MAX_REVISIONS = 3;

/**
 * A generate -> critique -> revise loop:
 *
 *   start -> writer -> critic --(approved or limit?)--> end
 *                 ^______________(revise)________|
 *
 * Unlike the ReAct loop, the loop condition here lives in custom state
 * (`approved`, `revision`), not in the message log.
 */
export const reflectionLoop: GraphDefinition<ReflectionState> = {
  id: "reflection",
  name: "Reflection (writer / critic)",
  description: `A writer drafts, a critic reviews. The draft is revised until the critic replies APPROVED or ${MAX_REVISIONS} revisions are reached.`,
  entry: "writer",
  maxSteps: 10,
  nodes: [
    functionNode<ReflectionState>({
      id: "writer",
      kind: "llm",
      label: "writer",
      description: "Writes a first draft, or revises the draft using the critique.",
      async run(state, ctx) {
        const prompt = state.draft
          ? `Task: ${state.task}\n\nYour previous draft:\n${state.draft}\n\nCritique to address:\n${state.critique}\n\nWrite the improved draft only.`
          : `Task: ${state.task}\n\nWrite the draft only.`;
        const res = await ctx.callLLM({
          system: "You are a concise, careful writer. Output only the draft text.",
          messages: [{ role: "user", text: prompt }],
          tools: [],
        });
        return { draft: res.text, revision: state.revision + 1 };
      },
    }),
    functionNode<ReflectionState>({
      id: "critic",
      kind: "llm",
      label: "critic",
      description: "Reviews the draft. Replies APPROVED, or lists concrete fixes.",
      async run(state, ctx) {
        const res = await ctx.callLLM({
          system:
            "You are a demanding editor. If the draft fully satisfies the task and is clear and accurate, reply with exactly APPROVED on the first line. Otherwise list at most three specific, actionable fixes.",
          messages: [{ role: "user", text: `Task: ${state.task}\n\nDraft (revision ${state.revision}):\n${state.draft}` }],
          tools: [],
        });
        return { critique: res.text, approved: /^\s*APPROVED\b/i.test(res.text) };
      },
    }),
  ],
  edges: [
    { from: "writer", to: "critic", label: "review" },
    {
      from: "critic",
      targets: ["writer", END],
      label: "approved?",
      branchLabels: { writer: "revise", [END]: "approved / limit" },
      route: (s) =>
        s.approved
          ? { to: END, reason: "critic approved the draft" }
          : s.revision >= MAX_REVISIONS
            ? { to: END, reason: `revision limit (${MAX_REVISIONS}) reached` }
            : { to: "writer", reason: "critic requested changes" },
    },
  ],
  initialState: (input) => ({
    messages: [{ role: "user", text: input }],
    task: input,
    draft: "",
    critique: "",
    revision: 0,
    approved: false,
  }),
  exampleInputs: [
    "Write a three-sentence explanation of an agentic loop for a junior developer.",
    "Write a haiku about debugging a race condition.",
  ],
  mockScripts: { writer: mockWriter, critic: mockCritic },
};

function mockWriter(req: LLMRequest, turn: number): MockReply {
  const versions = [
    "An agent loop calls a model again and again.",
    "An agentic loop calls a model, runs any tools it asks for, and feeds the results back. It repeats until the model answers.",
    "An agentic loop calls a model, runs the tools it requests, and feeds the results back as new context. It repeats until the model answers without asking for tools. A step limit stops it from running forever.",
  ];
  return {
    reasoning: turn === 0 ? "First draft: keep it minimal." : "Address each point in the critique.",
    text: versions[Math.min(turn, versions.length - 1)],
  };
}

function mockCritic(_req: LLMRequest, turn: number): MockReply {
  const critiques = [
    "1. Too vague: say what happens between model calls (tools).\n2. Explain when the loop stops.\n3. Aim for three sentences.",
    "1. Mention the safety limit that prevents infinite loops.\n2. Clarify that results are fed back as context.",
  ];
  const critique = critiques[turn];
  return critique
    ? { reasoning: "The draft is missing key ideas.", text: critique }
    : { reasoning: "All earlier points are addressed.", text: "APPROVED" };
}
