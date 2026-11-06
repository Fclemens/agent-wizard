import { END, type BaseState, type GraphDefinition, type MockReply } from "../graph";
import { functionNode, lastAssistant, llmNode, routeOnToolCalls, toolNode } from "../nodes";
import { searchNotesTool } from "../tools";
import type { LLMRequest, Tool, ToolCall } from "../types";
import { firstUserText, lastMessage } from "./mock-helpers";

const COMPANY_DOMAIN = "example.com";

/** Fake side-effecting tools: nothing is really sent or deleted. */
const sendEmailTool: Tool = {
  name: "send_email",
  description: "Send an email (simulated).",
  inputSchema: {
    type: "object",
    properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
    required: ["to", "subject", "body"],
  },
  run: (input) => `Email queued to ${String(input.to)} (simulated).`,
};

const deleteRecordsTool: Tool = {
  name: "delete_records",
  description: "Delete all records in a database table (simulated).",
  inputSchema: { type: "object", properties: { table: { type: "string" } }, required: ["table"] },
  run: (input) => `Deleted all rows from ${String(input.table)} (simulated).`,
};

const tools = [sendEmailTool, deleteRecordsTool, searchNotesTool];

/** The policy, as plain code. Returns a reason if the call is NOT allowed. */
export function checkPolicy(call: ToolCall): string | undefined {
  if (call.name === "delete_records") return "destructive operations need human approval and are blocked for agents";
  if (call.name === "send_email") {
    const to = String(call.input.to ?? "");
    if (!to.toLowerCase().endsWith(`@${COMPANY_DOMAIN}`)) {
      return `emails may only be sent to @${COMPANY_DOMAIN} addresses (got "${to}")`;
    }
  }
  return undefined;
}

export interface GuardState extends BaseState {
  violations: { call: string; reason: string }[];
}

/**
 * Guardrails: a policy gate between the model and its tools.
 *
 *   start -> agent --(tool calls)--> guard --(allowed)--> tools  -> agent
 *                |                          --(blocked)--> reject -> agent
 *                --(final answer)--> end
 *
 * The model never runs a tool directly. The guard (plain code) checks every
 * requested call; a blocked turn is answered with error results explaining
 * why, and the model gets another chance to find a compliant approach.
 */
export const guardrails: GraphDefinition<GuardState> = {
  id: "guardrails",
  name: "Guardrails (tool policy)",
  description: `Safety pattern: every tool call passes through a code policy check before it runs. Blocked: any delete_records, and emails outside @${COMPANY_DOMAIN}. The model sees why and can adapt.`,
  entry: "agent",
  maxSteps: 12,
  nodes: [
    llmNode<GuardState>({
      id: "agent",
      label: "agent",
      description: "An assistant with email and database tools.",
      system: `You are an operations assistant for a company whose domain is ${COMPANY_DOMAIN}. You can send emails and manage database tables. Tool calls are checked by a policy; if one is blocked, read the reason and find a compliant alternative instead of retrying the same call. Keep the final reply short.`,
      tools,
    }),
    functionNode<GuardState>({
      id: "guard",
      kind: "router",
      label: "policy guard",
      description: "Checks each requested tool call against the policy (no LLM).",
      run(state, ctx) {
        const calls = lastAssistant(state)?.toolCalls ?? [];
        const violations = calls.flatMap((c) => {
          const reason = checkPolicy(c);
          return reason ? [{ call: `${c.name}(${JSON.stringify(c.input)})`, reason }] : [];
        });
        ctx.emit({
          type: "log",
          message: violations.length ? `Blocked ${violations.length} of ${calls.length} call(s)` : `All ${calls.length} call(s) allowed`,
        });
        return { violations };
      },
    }),
    toolNode<GuardState>({ id: "tools", label: "tools", description: "Runs the approved calls.", tools }),
    functionNode<GuardState>({
      id: "reject",
      kind: "tool",
      label: "reject",
      description: "Answers every call in the blocked turn with an error result, so the model learns why.",
      run(state) {
        const calls = lastAssistant(state)?.toolCalls ?? [];
        return {
          messages: [
            {
              role: "tool",
              results: calls.map((c) => {
                const reason = checkPolicy(c);
                return {
                  toolCallId: c.id,
                  name: c.name,
                  isError: true,
                  output: reason
                    ? `BLOCKED BY POLICY: ${reason}`
                    : "Not executed: another call in the same turn was blocked. Re-request it if still needed.",
                };
              }),
            },
          ],
        };
      },
    }),
  ],
  edges: [
    {
      from: "agent",
      targets: ["guard", END],
      label: "tool calls?",
      branchLabels: { guard: "has tool calls", [END]: "final answer" },
      route: routeOnToolCalls("guard"),
    },
    {
      from: "guard",
      targets: ["tools", "reject"],
      label: "allowed?",
      branchLabels: { tools: "allowed", reject: "blocked" },
      route: (s) =>
        s.violations.length
          ? { to: "reject", reason: s.violations.map((v) => `${v.call}: ${v.reason}`).join("; ") }
          : { to: "tools", reason: "all calls comply with the policy" },
    },
    { from: "tools", to: "agent", label: "results" },
    { from: "reject", to: "agent", label: "policy errors" },
  ],
  initialState: (input) => ({ messages: [{ role: "user", text: input }], violations: [] }),
  exampleInputs: [
    "Email the Q3 summary to partner@gmail.com and clean up the old_logs table.",
    "Send a reminder about Friday's demo to team@example.com.",
  ],
  mockScripts: {
    agent: (req: LLMRequest): MockReply => {
      const last = lastMessage(req);
      const input = firstUserText(req);
      if (last?.role === "tool") {
        const blocked = last.results.filter((r) => r.output.startsWith("BLOCKED"));
        if (blocked.length) {
          return {
            reasoning: "The policy blocked external email and deletion. I can't do those, but I can send the summary internally so a human can forward it and approve the cleanup.",
            text: "Those actions are blocked. I'll send the request to the internal team instead.",
            toolCalls: [
              {
                name: "send_email",
                input: {
                  to: `team@${COMPANY_DOMAIN}`,
                  subject: "Action needed: forward Q3 summary and approve cleanup",
                  body: `Please forward the Q3 summary to the external partner and approve deleting the requested table. Original request: ${input}`,
                },
              },
            ],
          };
        }
        return { text: `Done. ${last.results.map((r) => r.output).join(" ")}` };
      }
      const calls: NonNullable<MockReply["toolCalls"]> = [];
      for (const to of input.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []) {
        calls.push({ name: "send_email", input: { to, subject: "Requested update", body: input } });
      }
      const table = input.match(/the (\w+) table/)?.[1];
      if (table && /clean|delete|drop|purge/i.test(input)) calls.push({ name: "delete_records", input: { table } });
      return calls.length
        ? { reasoning: "Do exactly what was asked.", text: "On it.", toolCalls: calls }
        : { text: "There's nothing for me to send or change." };
    },
  },
};
