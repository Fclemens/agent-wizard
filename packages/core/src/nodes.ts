import { type BaseState, END, type GraphNode, type NodeKind } from "./graph";
import type { ChatMessage, Tool, ToolResult } from "./types";

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
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  return {
    id: opts.id,
    kind: "tool",
    label: opts.label,
    description: opts.description,
    async run(state, ctx) {
      const calls = lastAssistant(state)?.toolCalls ?? [];
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
      return { messages: [{ role: "tool", results }] } as Partial<S>;
    },
  };
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
