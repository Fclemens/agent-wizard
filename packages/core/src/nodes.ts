import { type BaseState, END, type GraphNode, type NodeContext, type NodeKind } from "./graph";
import type { ChatMessage, Tool, ToolCall, ToolResult } from "./types";

/** The most recent assistant message, if any. */
export function lastAssistant(state: BaseState) {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m?.role === "assistant") return m;
  }
  return undefined;
}

/**
 * An LLM node: sends the conversation so far (plus tool specs) to the model
 * and appends the model's reply to `messages`.
 */
export function llmNode<S extends BaseState>(opts: {
  id: string;
  label?: string;
  description?: string;
  system?: string;
  tools?: Tool[];
}): GraphNode<S> {
  const specs = (opts.tools ?? []).map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
  return {
    id: opts.id,
    kind: "llm",
    label: opts.label,
    description: opts.description,
    async run(state, ctx) {
      const res = await ctx.callLLM({ system: opts.system, messages: state.messages, tools: specs });
      const message: ChatMessage = {
        role: "assistant",
        text: res.text,
        toolCalls: res.toolCalls,
        reasoning: res.reasoning,
        raw: res.raw,
      };
      return { messages: [message] } as Partial<S>;
    },
  };
}

/**
 * A tool node: executes every tool call in the last assistant message and
 * appends the results. Tool errors are returned to the model (isError) rather
 * than crashing the run, so the agent can recover.
 */
export function toolNode<S extends BaseState>(opts: {
  id: string;
  label?: string;
  description?: string;
  tools: Tool[];
}): GraphNode<S> {
  return {
    id: opts.id,
    kind: "tool",
    label: opts.label,
    description: opts.description,
    async run(state, ctx) {
      const results = await executeToolCalls(lastAssistant(state)?.toolCalls ?? [], opts.tools, ctx);
      return { messages: [{ role: "tool", results }] } as Partial<S>;
    },
  };
}

/**
 * Run tool calls and trace each one. Errors become isError results that are
 * returned to the model, so the agent can recover instead of the run crashing.
 */
export async function executeToolCalls(calls: ToolCall[], tools: Tool[], ctx: NodeContext): Promise<ToolResult[]> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const results: ToolResult[] = [];
  for (const call of calls) {
    ctx.emit({ type: "tool_call", call });
    const t0 = Date.now();
    const tool = byName.get(call.name);
    let result: ToolResult;
    if (!tool) {
      result = { toolCallId: call.id, name: call.name, output: `Unknown tool "${call.name}"`, isError: true };
    } else {
      try {
        result = { toolCallId: call.id, name: call.name, output: String(await tool.run(call.input)) };
      } catch (err) {
        result = {
          toolCallId: call.id,
          name: call.name,
          output: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    }
    ctx.emit({ type: "tool_result", result, durationMs: Date.now() - t0 });
    results.push(result);
  }
  return results;
}

/**
 * A complete agent loop (model -> tools -> model ...) packed inside ONE node.
 * Use it for sub-agents: from the outer graph's point of view the whole loop
 * is a single step, though every inner call still shows up in the trace.
 */
export async function runSubagent(
  ctx: NodeContext,
  opts: { system: string; task: string; tools: Tool[]; maxTurns?: number },
): Promise<{ text: string; turns: number }> {
  const specs = opts.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  const messages: ChatMessage[] = [{ role: "user", text: opts.task }];
  const maxTurns = opts.maxTurns ?? 4;
  for (let turn = 1; turn <= maxTurns; turn++) {
    const res = await ctx.callLLM({ system: opts.system, messages: [...messages], tools: specs });
    messages.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls, reasoning: res.reasoning, raw: res.raw });
    if (res.toolCalls.length === 0) return { text: res.text, turns: turn };
    const results = await executeToolCalls(res.toolCalls, opts.tools, ctx);
    messages.push({ role: "tool", results });
  }
  ctx.emit({ type: "log", message: `Sub-agent stopped after ${maxTurns} turns without a final answer` });
  return { text: "(sub-agent hit its turn limit without a final answer)", turns: maxTurns };
}

/** A plain function node for arbitrary state transformations. */
export function functionNode<S extends BaseState>(
  opts: { id: string; label?: string; description?: string; kind?: NodeKind } & Pick<GraphNode<S>, "run">,
): GraphNode<S> {
  return { kind: "function", ...opts };
}

/**
 * The classic ReAct router: if the model asked for tools, go run them;
 * otherwise the model is done.
 */
export function routeOnToolCalls(toolsNodeId: string) {
  return (state: BaseState) => {
    const calls = lastAssistant(state)?.toolCalls ?? [];
    return calls.length > 0
      ? { to: toolsNodeId, reason: `model requested ${calls.map((c) => c.name).join(", ")}` }
      : { to: END, reason: "no tool calls: model gave a final answer" };
  };
}

/** Parse "1. foo" / "- foo" / "* foo" lines into a list. */
export function parseList(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.match(/^\s*(?:\d+[.)]|[-*\u2022])\s+(.+)$/)?.[1]?.trim())
    .filter((l): l is string => Boolean(l));
}

/** Pull a JSON object out of model text (tolerates ```json fences and surrounding prose). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON object found in the response");
  return JSON.parse(fenced.slice(start, end + 1));
}
