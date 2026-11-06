import type { GraphDescription, ProviderInfo, TraceEvent } from "@agent-wizard/core";

export type { GraphDescription, ProviderInfo, TraceEvent };

export interface RunSummary {
  id: string;
  graphId: string;
  provider: string;
  model: string;
  input: string;
  status: "running" | "paused" | "completed" | "max_steps" | "error" | "cancelled";
  startedAt: number;
  steps: number;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export const api = {
  graphs: () => request<GraphDescription[]>("/api/graphs"),
  providers: () => request<ProviderInfo[]>("/api/providers"),
  runs: () => request<RunSummary[]>("/api/runs"),
  startRun: (body: { graphId: string; providerId: string; input: string; stepMode: boolean }) =>
    request<{ runId: string }>("/api/runs", { method: "POST", body: JSON.stringify(body) }),
  control: (runId: string, action: "step" | "pause" | "resume" | "cancel") =>
    request<{ ok: true }>(`/api/runs/${runId}/control`, { method: "POST", body: JSON.stringify({ action }) }),
  /** Replays the run's history, then streams live events until run_end. */
  subscribe(runId: string, onEvent: (e: TraceEvent) => void, onError: () => void) {
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.onmessage = (msg) => {
      const event = JSON.parse(msg.data as string) as TraceEvent;
      onEvent(event);
      if (event.type === "run_end") source.close();
    };
    source.onerror = () => {
      // The server closes the stream after run_end; EventSource would otherwise reconnect.
      source.close();
      onError();
    };
    return () => source.close();
  },
};
