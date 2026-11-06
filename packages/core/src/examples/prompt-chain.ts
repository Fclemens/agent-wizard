import { END, type BaseState, type GraphDefinition, type MockReply } from "../graph";
import { functionNode, parseList } from "../nodes";
import type { LLMRequest } from "../types";

export interface ChainState extends BaseState {
  topic: string;
  outline: string;
  outlineAttempts: number;
  gateFeedback: string;
  gatePassed: boolean;
  draft: string;
  final: string;
}

const MAX_OUTLINE_ATTEMPTS = 3;
const MAX_WORDS = 60;

/**
 * Prompt chaining with a programmatic gate:
 *
 *   start -> outline -> gate --(pass)--> draft -> polish -> end
 *               ^________|(fail: feedback)
 *
 * Each LLM step does one small job. The gate is plain code (no LLM): it checks
 * the outline's shape and sends it back with feedback if it's wrong. Cheap,
 * deterministic checks between model calls catch errors early.
 */
export const promptChain: GraphDefinition<ChainState> = {
  id: "prompt-chain",
  name: "Prompt chain + gate",
  description: `Pipeline pattern: outline -> code check -> draft -> polish. The gate is ordinary code that requires exactly 3 bullet points and sends the outline back (up to ${MAX_OUTLINE_ATTEMPTS} tries) if not.`,
  entry: "outline",
  maxSteps: 10,
  nodes: [
    functionNode<ChainState>({
      id: "outline",
      kind: "llm",
      label: "outline",
      description: "Writes a 3-point outline (and fixes it if the gate rejected it).",
      async run(state, ctx) {
        const retry = state.gateFeedback
          ? `\n\nYour previous outline was rejected:\n${state.outline}\n\nProblem: ${state.gateFeedback}`
          : "";
        const res = await ctx.callLLM({
          system: "You plan short announcements. Output only the outline, as lines starting with '- '.",
          messages: [{ role: "user", text: `Write an outline of exactly 3 bullet points for: ${state.topic}${retry}` }],
          tools: [],
        });
        return { outline: res.text.trim(), outlineAttempts: state.outlineAttempts + 1 };
      },
    }),
    functionNode<ChainState>({
      id: "gate",
      kind: "router",
      label: "gate (code)",
      description: "Deterministic check, no LLM: exactly 3 bullets, each under 15 words.",
      run(state, ctx) {
        const bullets = parseList(state.outline);
        const problems: string[] = [];
        if (bullets.length !== 3) problems.push(`expected exactly 3 bullet points, found ${bullets.length}`);
        const long = bullets.filter((b) => b.split(/\s+/).length > 15);
        if (long.length) problems.push(`${long.length} bullet(s) longer than 15 words`);
        const gateFeedback = problems.join("; ");
        ctx.emit({ type: "log", message: gateFeedback ? `Gate failed: ${gateFeedback}` : "Gate passed" });
        return { gatePassed: problems.length === 0, gateFeedback };
      },
    }),
    functionNode<ChainState>({
      id: "draft",
      kind: "llm",
      label: "draft",
      description: "Turns the approved outline into a paragraph.",
      async run(state, ctx) {
        const res = await ctx.callLLM({
          system: "You write clear product copy. Output only the paragraph.",
          messages: [{ role: "user", text: `Topic: ${state.topic}\nOutline:\n${state.outline}\n\nWrite one paragraph covering every point.` }],
          tools: [],
        });
        return { draft: res.text.trim() };
      },
    }),
    functionNode<ChainState>({
      id: "polish",
      kind: "llm",
      label: "polish",
      description: `Tightens the draft to under ${MAX_WORDS} words.`,
      async run(state, ctx) {
        const res = await ctx.callLLM({
          system: "You are an editor. Output only the rewritten text.",
          messages: [{ role: "user", text: `Rewrite this in under ${MAX_WORDS} words, punchy and friendly:\n\n${state.draft}` }],
          tools: [],
        });
        const final = res.text.trim();
        return { final, messages: [{ role: "assistant", text: final, toolCalls: [] }] };
      },
    }),
  ],
  edges: [
    { from: "outline", to: "gate", label: "check" },
    {
      from: "gate",
      targets: ["draft", "outline", END],
      label: "valid?",
      branchLabels: { draft: "pass", outline: "fail: retry", [END]: "give up" },
      route: (s) =>
        s.gatePassed
          ? { to: "draft", reason: "outline passed the gate" }
          : s.outlineAttempts >= MAX_OUTLINE_ATTEMPTS
            ? { to: END, reason: `outline failed ${MAX_OUTLINE_ATTEMPTS} times; stopping` }
            : { to: "outline", reason: `gate failed: ${s.gateFeedback}` },
    },
    { from: "draft", to: "polish" },
    { from: "polish", to: END },
  ],
  initialState: (input) => ({
    messages: [{ role: "user", text: input }],
    topic: input,
    outline: "",
    outlineAttempts: 0,
    gateFeedback: "",
    gatePassed: false,
    draft: "",
    final: "",
  }),
  exampleInputs: [
    "Announce dark mode for our note-taking app.",
    "Announce that our API now supports webhooks.",
  ],
  mockScripts: {
    outline: (_req: LLMRequest, turn: number): MockReply =>
      turn === 0
        ? {
            reasoning: "List everything worth saying.",
            text: "- Dark mode is here\n- Easier on the eyes at night\n- Saves battery on OLED screens\n- Turn it on in Settings > Appearance",
          }
        : {
            reasoning: "The gate wants exactly 3 points; merge the two benefits.",
            text: "- Dark mode is here\n- Easier on the eyes and saves battery\n- Turn it on in Settings > Appearance",
          },
    draft: () => ({
      text: "Dark mode has arrived in your favorite note-taking app! Whether you write late at night or just prefer a darker look, the new theme is easier on your eyes and helps your battery last longer on OLED screens. To switch it on, open Settings, choose Appearance, and select Dark. Your notes have never looked so good after sunset.",
    }),
    polish: () => ({
      text: "Dark mode is here! Easier on your eyes, kinder to your battery, and gorgeous after sunset. Turn it on in Settings > Appearance > Dark.",
    }),
  },
};
