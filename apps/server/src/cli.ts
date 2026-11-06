/**
 * Run a graph from the terminal and print its trace.
 *
 *   npm run cli -- <graph-id> "<input>" [--provider mock|anthropic|openai-compatible] [--json]
 */
import { type TraceEvent, createProvider, exampleGraphs, runGraph } from "@agent-wizard/core";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, value && !value.startsWith("--") ? 2 : 1);
  return value ?? "";
};
const providerId = flag("provider") ?? "mock";
const asJson = flag("json") !== undefined;
const [graphId, ...rest] = args;
const graph = exampleGraphs.find((g) => g.id === graphId);

if (!graph) {
  console.error(`Usage: npm run cli -- <graph> "<input>" [--provider mock|anthropic|openai-compatible] [--json]`);
  console.error(`Graphs: ${exampleGraphs.map((g) => g.id).join(", ")}`);
  process.exit(1);
}
const input = rest.join(" ") || graph.exampleInputs?.[0] || "";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const color = (n: number, s: string) => `\x1b[${n}m${s}\x1b[0m`;
const short = (v: unknown, n = 160) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

function print(e: TraceEvent) {
  if (asJson) return console.log(JSON.stringify(e));
  switch (e.type) {
    case "run_start":
      return console.log(bold(`▶ ${e.graphId}`), dim(`${e.provider}/${e.model}`), `\n  input: ${e.input}`);
    case "node_start":
      return console.log(`\n${color(36, `[step ${e.step}]`)} ${bold(e.node)}`);
    case "llm_response":
      if (e.response.reasoning) console.log(dim(`  thinking: ${short(e.response.reasoning)}`));
      if (e.response.text) console.log(`  ${color(32, "model:")} ${short(e.response.text, 400)}`);
      for (const c of e.response.toolCalls) console.log(`  ${color(33, "→ call")} ${c.name}(${short(c.input)})`);
      return console.log(
        dim(`  ${e.durationMs}ms · stop=${e.response.stopReason} · ${e.response.usage?.inputTokens ?? "?"} in / ${e.response.usage?.outputTokens ?? "?"} out`),
      );
    case "tool_result":
      return console.log(
        `  ${e.result.isError ? color(31, "✗ result") : color(33, "← result")} ${e.result.name}: ${short(e.result.output)}`,
      );
    case "node_end":
      return console.log(dim(`  update: ${short(e.update, 200)}`));
    case "edge":
      return console.log(color(35, `  ↳ ${e.from} → ${e.to}`), dim(`(${e.reason})`));
    case "run_end":
      console.log(
        `\n${bold(e.status === "completed" ? color(32, "■ completed") : color(31, `■ ${e.status}`))} ${dim(
          `${e.steps} steps · ${e.durationMs}ms · ${e.usage.inputTokens} in / ${e.usage.outputTokens} out tokens`,
        )}`,
      );
      if (e.error) console.log(color(31, `  error: ${e.error}`));
      return;
  }
}

const result = await runGraph(graph, { provider: createProvider(providerId, graph), input, onEvent: print });
process.exit(result.status === "completed" ? 0 : 1);
