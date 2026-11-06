import type { Tool } from "./types";

/** Safe arithmetic: + - * / ^ % parentheses, decimals, unary minus. No eval. */
export function evaluateArithmetic(expression: string): number {
  const tokens = expression.match(/\d+(?:\.\d+)?|[-+*/^%()]/g);
  if (!tokens || tokens.join("") !== expression.replace(/\s+/g, "")) {
    throw new Error(`Invalid expression: ${expression}`);
  }
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];

  const parsePrimary = (): number => {
    const t = take();
    if (t === undefined) throw new Error("Unexpected end of expression");
    if (t === "(") {
      const v = parseAdd();
      if (take() !== ")") throw new Error("Missing closing parenthesis");
      return v;
    }
    if (t === "-") return -parseUnary();
    if (t === "+") return parseUnary();
    const n = Number(t);
    if (Number.isNaN(n)) throw new Error(`Unexpected token "${t}"`);
    return n;
  };
  const parseUnary = (): number => parsePrimary();
  const parsePow = (): number => {
    const base = parseUnary();
    if (peek() === "^") {
      take();
      return base ** parsePow(); // right-associative
    }
    return base;
  };
  const parseMul = (): number => {
    let v = parsePow();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = take();
      const r = parsePow();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  };
  const parseAdd = (): number => {
    let v = parseMul();
    while (peek() === "+" || peek() === "-") {
      const op = take();
      const r = parseMul();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };

  const value = parseAdd();
  if (pos !== tokens.length) throw new Error(`Unexpected token "${tokens[pos]}"`);
  if (!Number.isFinite(value)) throw new Error("Result is not a finite number");
  return value;
}

export const calculatorTool: Tool = {
  name: "calculator",
  description:
    "Evaluate an arithmetic expression. Supports + - * / % ^ and parentheses. Use it for any math instead of computing in your head.",
  inputSchema: {
    type: "object",
    properties: { expression: { type: "string", description: "e.g. (12.5 * 4) ^ 2 - 7" } },
    required: ["expression"],
  },
  run(input) {
    const expression = String(input.expression ?? "");
    // Round away float noise (0.1 + 0.2 -> 0.3) so models don't trip over it.
    return String(Number(evaluateArithmetic(expression).toPrecision(12)));
  },
};

export const currentTimeTool: Tool = {
  name: "get_current_time",
  description: "Get the current date and time in ISO 8601 format (UTC).",
  inputSchema: { type: "object", properties: {} },
  run() {
    return new Date().toISOString();
  },
};

/** A tiny offline knowledge base so the demo works without web access. */
export const NOTES: Record<string, string> = {
  "agentic loop":
    "An agentic loop repeatedly calls a model, executes any tools it requests, feeds the results back, and stops when the model answers without requesting tools (or a step limit is hit).",
  react:
    "ReAct (Reason + Act) interleaves reasoning with tool use: think, call a tool, observe the result, repeat until the answer is known.",
  "state graph":
    "A state graph models an agent as nodes (steps that read and update shared state) connected by edges. Conditional edges choose the next node from the current state, and cycles create loops.",
  reflection:
    "Reflection is a loop where one step produces a draft and another critiques it; the draft is revised until the critic approves or a revision limit is reached.",
  "tool calling":
    "Tool calling lets a model request a function call with structured arguments. The harness runs the function and returns the result as a tool_result message.",
};

export const searchNotesTool: Tool = {
  name: "search_notes",
  description: `Look up a short note on an agent-design topic. Known topics: ${Object.keys(NOTES).join(", ")}.`,
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "Topic to look up" } },
    required: ["query"],
  },
  run(input) {
    const q = String(input.query ?? "").toLowerCase();
    const hit = Object.entries(NOTES).find(([k]) => q.includes(k) || k.includes(q));
    if (!hit) throw new Error(`No note found for "${q}". Known topics: ${Object.keys(NOTES).join(", ")}`);
    return hit[1];
  },
};

export const builtinTools: Tool[] = [calculatorTool, currentTimeTool, searchNotesTool];
