import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeGraph, exampleGraphs, listProviders } from "@agent-wizard/core";
import { RunStore } from "./runs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const RUNS_DIR = process.env.RUNS_DIR ?? path.join(repoRoot, "runs");
const WEB_DIST = path.join(repoRoot, "apps/web/dist");

const graphs = new Map(exampleGraphs.map((g) => [g.id, g]));
const store = new RunStore(RUNS_DIR);
await store.load();

const server = createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    else res.end();
  });
});

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method ?? "GET";

  if (parts[0] !== "api") return serveStatic(url.pathname, res);

  // GET /api/graphs
  if (method === "GET" && url.pathname === "/api/graphs") {
    return json(res, 200, [...graphs.values()].map(describeGraph));
  }
  // GET /api/providers
  if (method === "GET" && url.pathname === "/api/providers") {
    return json(res, 200, listProviders());
  }
  // GET /api/runs
  if (method === "GET" && url.pathname === "/api/runs") {
    return json(res, 200, store.list());
  }
  // POST /api/runs  { graphId, providerId, input, stepMode }
  if (method === "POST" && url.pathname === "/api/runs") {
    const body = (await readJson(req)) as Partial<{
      graphId: string;
      providerId: string;
      input: string;
      stepMode: boolean;
    }>;
    const graph = graphs.get(body.graphId ?? "");
    if (!graph) return json(res, 400, { error: `Unknown graph "${body.graphId}"` });
    if (!body.input?.trim()) return json(res, 400, { error: "input is required" });
    try {
      const runId = store.start(graph, {
        providerId: body.providerId ?? "mock",
        input: body.input,
        stepMode: Boolean(body.stepMode),
      });
      return json(res, 201, { runId });
    } catch (err) {
      return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  const runId = parts[1] === "runs" ? parts[2] : undefined;
  const run = runId ? store.get(runId) : undefined;
  if (runId && !run) return json(res, 404, { error: `Unknown run "${runId}"` });

  // GET /api/runs/:id
  if (run && method === "GET" && parts.length === 3) {
    return json(res, 200, { summary: run.summary, events: run.events });
  }
  // GET /api/runs/:id/events  (Server-Sent Events: replays history, then streams live)
  if (run && method === "GET" && parts[3] === "events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    for (const e of run.events) send(e);
    if (run.events.at(-1)?.type === "run_end") return res.end();
    const listener = (e: (typeof run.events)[number]) => {
      send(e);
      if (e.type === "run_end") {
        run.listeners.delete(listener);
        res.end();
      }
    };
    run.listeners.add(listener);
    req.on("close", () => run.listeners.delete(listener));
    return;
  }
  // POST /api/runs/:id/control  { action: "step" | "pause" | "resume" | "cancel" }
  if (run && method === "POST" && parts[3] === "control") {
    const { action } = (await readJson(req)) as { action?: string };
    if (!store.control(run.summary.id, action ?? "")) {
      return json(res, 409, { error: `Cannot "${action}" this run (finished or unknown action)` });
    }
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: "Not found" });
}

async function serveStatic(pathname: string, res: ServerResponse) {
  if (!existsSync(WEB_DIST)) {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("agent-wizard API is running. Start the UI with `npm run dev`, or build it with `npm run build`.");
  }
  const types: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".json": "application/json",
  };
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let file = path.join(WEB_DIST, safe);
  if (!file.startsWith(WEB_DIST) || !existsSync(file) || pathname === "/") file = path.join(WEB_DIST, "index.html");
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
  res.end(await readFile(file));
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Request body is not valid JSON");
  }
}

server.listen(PORT, HOST, () => {
  console.log(`agent-wizard server listening on http://${HOST}:${PORT}`);
  console.log(`Graphs: ${[...graphs.keys()].join(", ")}`);
  console.log(
    `Providers: ${listProviders()
      .map((p) => `${p.id}${p.configured ? "" : " (not configured)"}`)
      .join(", ")}`,
  );
});
