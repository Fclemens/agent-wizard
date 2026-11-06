import { END, type BaseState, type GraphDefinition, type MockReply } from "../graph";
import { functionNode, llmNode } from "../nodes";
import type { LLMRequest } from "../types";
import { firstUserText } from "./mock-helpers";

const CATEGORIES = ["billing", "technical", "general"] as const;
type Category = (typeof CATEGORIES)[number];

export interface RouterState extends BaseState {
  category: Category | "";
}

/**
 * Routing: classify once, then hand off to exactly one specialist.
 *
 *   start -> classify --(billing)--> billing_agent  -> end
 *                     --(technical)--> tech_agent   -> end
 *                     --(general)--> general_agent  -> end
 *
 * No loop at all. This is the simplest useful "workflow": a cheap decision up
 * front lets each specialist have a focused prompt.
 */
export const intentRouter: GraphDefinition<RouterState> = {
  id: "intent-router",
  name: "Intent router",
  description:
    "Routing pattern: one classification call picks a specialist, which answers. No loop: shows conditional branching on its own.",
  entry: "classify",
  maxSteps: 5,
  nodes: [
    functionNode<RouterState>({
      id: "classify",
      kind: "llm",
      label: "classify",
      description: "Asks the model for a single category word and stores it in state.",
      async run(state, ctx) {
        const res = await ctx.callLLM({
          system: `Classify the customer's message into exactly one category: ${CATEGORIES.join(", ")}. Reply with only the category word, lowercase.`,
          messages: state.messages,
          tools: [],
        });
        const word = res.text.trim().toLowerCase();
        const category = CATEGORIES.find((c) => word.includes(c)) ?? "general";
        if (!CATEGORIES.some((c) => word === c)) {
          ctx.emit({ type: "log", message: `Unexpected classifier output "${res.text}", using "${category}"` });
        }
        return { category };
      },
    }),
    llmNode<RouterState>({
      id: "billing_agent",
      label: "billing agent",
      description: "Specialist prompt for payments, invoices and refunds.",
      system:
        "You are a billing support specialist. Be empathetic, explain the likely cause, and give the exact next steps for refunds or invoice corrections. Under 80 words.",
    }),
    llmNode<RouterState>({
      id: "tech_agent",
      label: "tech agent",
      description: "Specialist prompt for bugs and troubleshooting.",
      system:
        "You are a technical support engineer. Ask for no more than one missing detail, and give numbered troubleshooting steps. Under 100 words.",
    }),
    llmNode<RouterState>({
      id: "general_agent",
      label: "general agent",
      description: "Friendly catch-all.",
      system: "You are a friendly front-desk assistant. Answer briefly and helpfully. Under 60 words.",
    }),
  ],
  edges: [
    {
      from: "classify",
      targets: ["billing_agent", "tech_agent", "general_agent"],
      label: "category?",
      branchLabels: { billing_agent: "billing", tech_agent: "technical", general_agent: "general" },
      route: (s) => {
        const to = s.category === "billing" ? "billing_agent" : s.category === "technical" ? "tech_agent" : "general_agent";
        return { to, reason: `classified as "${s.category}"` };
      },
    },
    { from: "billing_agent", to: END },
    { from: "tech_agent", to: END },
    { from: "general_agent", to: END },
  ],
  initialState: (input) => ({ messages: [{ role: "user", text: input }], category: "" }),
  exampleInputs: [
    "I was charged twice for my subscription this month.",
    "The app crashes whenever I upload a file larger than 10 MB.",
    "What are your support hours on weekends?",
  ],
  mockScripts: {
    classify: (req: LLMRequest): MockReply => {
      const t = firstUserText(req).toLowerCase();
      const category = /charg|refund|invoice|bill|payment|price/.test(t)
        ? "billing"
        : /crash|error|bug|upload|login|slow|broken/.test(t)
          ? "technical"
          : "general";
      return { reasoning: `Keywords point to ${category}.`, text: category };
    },
    billing_agent: () => ({
      text: "Sorry about the double charge! This usually happens when a payment is retried after a timeout. I've flagged it: the duplicate will be refunded to your card within 5 business days. You'll get a confirmation email shortly.",
    }),
    tech_agent: () => ({
      text: "Thanks for reporting this. Please try:\n1. Update to the latest app version.\n2. Upload over Wi-Fi rather than mobile data.\n3. If it still crashes, which device and OS version are you on?",
    }),
    general_agent: () => ({ text: "Our support team is available Saturday and Sunday from 10:00 to 16:00 CET." }),
  },
};
