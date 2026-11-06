import type { ChatMessage } from "@agent-wizard/core";
import type { ReactNode } from "react";
import type { TraceEvent } from "../api";
import { summarizeEvent } from "./Timeline";

export function Inspector({ event }: { event?: TraceEvent }) {
  if (!event) return <p className="empty">Select an event in the timeline to inspect it.</p>;
  const s = summarizeEvent(event);
  return (
    <div className="inspector">
      <h3>
        <span aria-hidden>{s.icon}</span> {s.title}
      </h3>
      <p className="muted">
        step {event.step} · event #{event.seq} · {new Date(event.ts).toLocaleTimeString()}
      </p>
      <Body event={event} />
    </div>
  );
}

function Body({ event: e }: { event: TraceEvent }) {
  switch (e.type) {
    case "run_start":
      return (
        <>
          <Field label="Input">{e.input}</Field>
          <Field label="Provider">
            {e.provider} · <code>{e.model}</code>
          </Field>
          <Json label="Initial state" value={e.initialState} />
        </>
      );
    case "node_start":
      return <StateView label={`State entering "${e.node}"`} state={e.state} />;
    case "llm_request":
      return (
        <>
          {e.request.system && <Field label="System prompt">{e.request.system}</Field>}
          <Field label={`Tools (${e.request.tools.length})`}>
            {e.request.tools.length ? e.request.tools.map((t) => <code key={t.name}>{t.name} </code>) : "none"}
          </Field>
          <Field label={`Messages sent (${e.request.messages.length})`}>
            <Messages messages={e.request.messages} />
          </Field>
        </>
      );
    case "llm_response":
      return (
        <>
          <Field label="Stop reason">
            <code>{e.response.stopReason}</code> · {e.durationMs}ms · <code>{e.response.model}</code>
          </Field>
          {e.response.usage && (
            <Field label="Tokens">
              {e.response.usage.inputTokens} in / {e.response.usage.outputTokens} out
            </Field>
          )}
          {e.response.reasoning && (
            <Field label="Reasoning (summary)">
              <div className="reasoning">{e.response.reasoning}</div>
            </Field>
          )}
          {e.response.text && <Field label="Text">{e.response.text}</Field>}
          {e.response.toolCalls.length > 0 && <Json label="Tool calls" value={e.response.toolCalls} />}
        </>
      );
    case "tool_call":
      return <Json label={`Input to ${e.call.name}`} value={e.call.input} />;
    case "tool_result":
      return (
        <>
          <Field label="Duration">{e.durationMs}ms</Field>
          <Field label={e.result.isError ? "Error (returned to the model)" : "Output"}>
            <pre className="pre">{e.result.output}</pre>
          </Field>
        </>
      );
    case "node_end":
      return (
        <>
          <p className="hint">
            The node's update is merged into state: <code>messages</code> is appended, every other key replaced.
          </p>
          <StateView label="Update" state={e.update} />
        </>
      );
    case "edge":
      return (
        <Field label="Why this edge">
          {e.reason}
        </Field>
      );
    case "paused":
      return <p className="hint">Step mode: the engine is waiting before running "{e.nextNode}". Press Step to run it.</p>;
    case "log":
      return <Field label="Message">{e.message}</Field>;
    case "run_end":
      return (
        <>
          <Field label="Status">
            <code>{e.status}</code>
            {e.error ? ` · ${e.error}` : ""}
          </Field>
          <Field label="Totals">
            {e.steps} steps · {e.durationMs}ms · {e.usage.inputTokens} in / {e.usage.outputTokens} out tokens
          </Field>
          <StateView label="Final state" state={e.finalState} />
        </>
      );
  }
}

function StateView({ label, state }: { label: string; state: unknown }) {
  const obj = (state ?? {}) as { messages?: ChatMessage[] } & Record<string, unknown>;
  const { messages, ...rest } = obj;
  return (
    <>
      {Object.keys(rest).length > 0 && <Json label={label} value={rest} />}
      {messages && messages.length > 0 && (
        <Field label={`${label}: messages (${messages.length})`}>
          <Messages messages={messages} />
        </Field>
      )}
      {!messages?.length && !Object.keys(rest).length && <Field label={label}>(empty)</Field>}
    </>
  );
}

function Messages({ messages }: { messages: ChatMessage[] }) {
  return (
    <ol className="msgs">
      {messages.map((m, i) => (
        <li key={i} className={`msg msg--${m.role}`}>
          <span className="msg__role">{m.role}</span>
          {m.role === "user" && <div className="msg__text">{m.text}</div>}
          {m.role === "assistant" && (
            <>
              {m.reasoning && <div className="reasoning">{m.reasoning}</div>}
              {m.text && <div className="msg__text">{m.text}</div>}
              {m.toolCalls.map((c) => (
                <div key={c.id} className="msg__call">
                  → {c.name}({JSON.stringify(c.input)})
                </div>
              ))}
            </>
          )}
          {m.role === "tool" &&
            m.results.map((r) => (
              <div key={r.toolCallId} className={`msg__result${r.isError ? " msg__result--error" : ""}`}>
                ← {r.name}: {r.output}
              </div>
            ))}
        </li>
      ))}
    </ol>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="field">
      <h4>{label}</h4>
      <div className="field__body">{children}</div>
    </section>
  );
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <Field label={label}>
      <pre className="pre">{JSON.stringify(value, null, 2)}</pre>
    </Field>
  );
}
