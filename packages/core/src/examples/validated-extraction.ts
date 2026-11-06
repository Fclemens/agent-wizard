import { END, type BaseState, type GraphDefinition, type MockReply } from "../graph";
import { extractJson, functionNode, lastAssistant } from "../nodes";
import type { LLMRequest } from "../types";

export interface ExtractionState extends BaseState {
  extracted: Record<string, unknown> | null;
  errors: string[];
  attempts: number;
}

const MAX_ATTEMPTS = 3;
const SCHEMA_TEXT = `{
  "name": string,            // full name of the sender
  "email": string,           // valid email address
  "company": string,
  "meeting_date": string,    // ISO date YYYY-MM-DD
  "attendees": integer       // number of people attending, as a number
}`;

/** The validator: plain code, returns a list of human-readable problems. */
export function validateContact(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["Output must be a JSON object"];
  const v = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of ["name", "email", "company", "meeting_date", "attendees"]) {
    if (!(key in v)) errors.push(`Missing key "${key}"`);
  }
  if ("name" in v && (typeof v.name !== "string" || !v.name.trim())) errors.push(`"name" must be a non-empty string`);
  if ("email" in v && !(typeof v.email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email))) {
    errors.push(`"email" is not a valid email address: ${JSON.stringify(v.email)}`);
  }
  if ("company" in v && (typeof v.company !== "string" || !v.company.trim())) errors.push(`"company" must be a non-empty string`);
  if ("meeting_date" in v) {
    const d = v.meeting_date;
    if (!(typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)))) {
      errors.push(`"meeting_date" must be YYYY-MM-DD, got ${JSON.stringify(d)}`);
    }
  }
  if ("attendees" in v && !(typeof v.attendees === "number" && Number.isInteger(v.attendees) && v.attendees > 0)) {
    errors.push(`"attendees" must be a positive integer (a JSON number), got ${JSON.stringify(v.attendees)}`);
  }
  const extra = Object.keys(v).filter((k) => !["name", "email", "company", "meeting_date", "attendees"].includes(k));
  if (extra.length) errors.push(`Unexpected keys: ${extra.join(", ")}`);
  return errors;
}

/**
 * Self-correction through validation:
 *
 *   start -> extract -> validate --(valid)--> end
 *               ^_________|(errors fed back as a user message)
 *
 * The model's output is checked by code. Errors are appended to the
 * conversation, so on the retry the model sees its previous answer AND
 * exactly what was wrong with it.
 */
export const validatedExtraction: GraphDefinition<ExtractionState> = {
  id: "validated-extraction",
  name: "Validated extraction",
  description: `Self-correction pattern: extract JSON from text, validate it with code, and feed the exact errors back to the model until it passes (max ${MAX_ATTEMPTS} attempts).`,
  entry: "extract",
  maxSteps: 8,
  nodes: [
    functionNode<ExtractionState>({
      id: "extract",
      kind: "llm",
      label: "extract",
      description: "Asks the model for JSON matching the schema. Sees earlier errors on retries.",
      async run(state, ctx) {
        const res = await ctx.callLLM({
          system: `Extract contact and meeting details from the user's message. Reply with only a JSON object in this shape:\n${SCHEMA_TEXT}`,
          messages: state.messages,
          tools: [],
        });
        return {
          attempts: state.attempts + 1,
          messages: [{ role: "assistant", text: res.text, toolCalls: [], reasoning: res.reasoning, raw: res.raw }],
        };
      },
    }),
    functionNode<ExtractionState>({
      id: "validate",
      kind: "router",
      label: "validate (code)",
      description: "Parses and checks the JSON. On failure, appends the errors as a user message.",
      run(state) {
        const text = lastAssistant(state)?.text ?? "";
        let parsed: unknown;
        let errors: string[];
        try {
          parsed = extractJson(text);
          errors = validateContact(parsed);
        } catch (err) {
          parsed = null;
          errors = [`Could not parse JSON: ${err instanceof Error ? err.message : String(err)}`];
        }
        if (errors.length === 0) return { extracted: parsed as Record<string, unknown>, errors };
        return {
          extracted: null,
          errors,
          messages: [
            {
              role: "user",
              text: `Your JSON failed validation:\n${errors.map((e) => `- ${e}`).join("\n")}\nReturn the corrected JSON object only.`,
            },
          ],
        };
      },
    }),
  ],
  edges: [
    { from: "extract", to: "validate", label: "check" },
    {
      from: "validate",
      targets: [END, "extract"],
      label: "valid?",
      branchLabels: { [END]: "valid / give up", extract: "fix errors" },
      route: (s) =>
        s.errors.length === 0
          ? { to: END, reason: "JSON passed validation" }
          : s.attempts >= MAX_ATTEMPTS
            ? { to: END, reason: `still invalid after ${MAX_ATTEMPTS} attempts` }
            : { to: "extract", reason: `${s.errors.length} validation error(s): ${s.errors.join("; ")}` },
    },
  ],
  initialState: (input) => ({ messages: [{ role: "user", text: input }], extracted: null, errors: [], attempts: 0 }),
  exampleInputs: [
    "Hi, this is Dana Whitfield from Northwind Traders (dana.w@northwind.example). Could we meet on March 5th, 2026? I'll bring four people from my team.",
    "Hello! Marco Rossi here, from Acme Robotics. Reach me at marco at acme dot io. Thinking next Tuesday 2026-04-14, just the two of us.",
  ],
  mockScripts: {
    extract: (req: LLMRequest, turn: number): MockReply => {
      const text = req.messages.find((m) => m.role === "user");
      const input = text?.role === "user" ? text.text : "";
      const dana = input.includes("Dana");
      if (turn === 0) {
        return {
          reasoning: "Copy the details as written.",
          text: dana
            ? '```json\n{"name": "Dana Whitfield", "email": "dana.w@northwind.example", "company": "Northwind Traders", "meeting_date": "March 5th, 2026", "attendees": "four"}\n```'
            : '{"name": "Marco Rossi", "email": "marco at acme dot io", "company": "Acme Robotics", "meeting_date": "2026-04-14", "attendees": 2}',
        };
      }
      return {
        reasoning: "Fix exactly the fields the validator complained about.",
        text: dana
          ? '{"name": "Dana Whitfield", "email": "dana.w@northwind.example", "company": "Northwind Traders", "meeting_date": "2026-03-05", "attendees": 5}'
          : '{"name": "Marco Rossi", "email": "marco@acme.io", "company": "Acme Robotics", "meeting_date": "2026-04-14", "attendees": 2}',
      };
    },
  },
};
