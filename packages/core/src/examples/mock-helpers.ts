import type { MockReply } from "../graph";
import { NOTES } from "../tools";
import type { ChatMessage, LLMRequest } from "../types";

/** Heuristic tool picker used by mock scripts: math -> calculator, time -> clock, topics -> notes. */
export function guessToolCalls(text: string): NonNullable<MockReply["toolCalls"]> {
  const lower = text.toLowerCase();
  const calls: NonNullable<MockReply["toolCalls"]> = [];
  const math = text.match(/[\d(][\d\s.+\-*/^%()]*[\d)]/g)?.filter((m) => /[+\-*/^%]/.test(m));
  for (const expression of math ?? []) calls.push({ name: "calculator", input: { expression: balanceParens(expression.trim()) } });
  if (/\b(time|date|today|now)\b/.test(lower)) calls.push({ name: "get_current_time", input: {} });
  for (const query of Object.keys(NOTES).filter((t) => lower.includes(t))) {
    calls.push({ name: "search_notes", input: { query } });
  }
  return calls;
}

export function lastMessage(req: LLMRequest): ChatMessage | undefined {
  return req.messages[req.messages.length - 1];
}

/** Text of the first user message in the request. */
export function firstUserText(req: LLMRequest): string {
  const m = req.messages.find((x) => x.role === "user");
  return m?.role === "user" ? m.text : "";
}

/** If the last message holds tool results, summarize them as a final answer. */
export function answerFromToolResults(req: LLMRequest): MockReply | undefined {
  const last = lastMessage(req);
  if (last?.role !== "tool") return undefined;
  return {
    reasoning: "I have the tool results; answer now.",
    text: last.results.map((r) => (r.isError ? `${r.name} failed: ${r.output}` : r.output)).join("\n"),
  };
}

/** Drop unmatched parentheses picked up from surrounding prose, e.g. "2400 * 0.15)". */
function balanceParens(expr: string): string {
  let out = expr;
  while (out.endsWith(")") && (out.match(/\)/g)?.length ?? 0) > (out.match(/\(/g)?.length ?? 0)) out = out.slice(0, -1).trim();
  while (out.startsWith("(") && (out.match(/\(/g)?.length ?? 0) > (out.match(/\)/g)?.length ?? 0)) out = out.slice(1).trim();
  return out;
}
