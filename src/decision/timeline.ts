/**
 * Event-timeline reconstruction — the "investigator" reflex, in code.
 *
 * The spec gives no raw transcript, only LLM-derived `insights`. So our ground
 * truth for chronology is the TIMESTAMPS of the signals we do have: the call, each
 * tool event, the promised payment date, the requested callback. buildTimeline
 * orders them; the engine folds a summary into the auditLog so every decision
 * shows *which event happened last*.
 *
 * When debriefed with "the payment says A but the LLM says B", this is the answer:
 * order events by time, see which is latest, and decide (or escalate) from that.
 * With a real transcript we'd parse it into the same TimelineEvent stream.
 */

import type { PostCallInput } from "./types";

export interface TimelineEvent {
  at: string; // ISO timestamp
  kind: string; // e.g. "call", "tool:send_payment_link:success", "promise_date", "callback"
  detail: string;
}

const millis = (iso: string): number => {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** Collect every timestamped signal and order it chronologically (stable on ties). */
export const buildTimeline = (input: PostCallInput): TimelineEvent[] => {
  const events: TimelineEvent[] = [
    {
      at: input.call.performedAt,
      kind: "call",
      detail: `status=${input.call.status ?? "?"}, amd=${input.call.amdStatus ?? "?"}, dur=${input.call.durationSec ?? "?"}s`,
    },
  ];

  for (const toolEvent of input.toolEvents ?? []) {
    events.push({
      at: toolEvent.createdAt,
      kind: `tool:${toolEvent.name}:${toolEvent.status}`,
      detail: toolEvent.name,
    });
  }
  if (input.insights.paymentDate) {
    events.push({
      at: input.insights.paymentDate,
      kind: "promise_date",
      detail: "payment promised",
    });
  }
  if (input.insights.callbackAt) {
    events.push({
      at: input.insights.callbackAt,
      kind: "callback",
      detail: "callback requested",
    });
  }

  return events.sort((left, right) => {
    const leftMillis = millis(left.at);
    const rightMillis = millis(right.at);
    return leftMillis !== rightMillis
      ? leftMillis - rightMillis
      : left.kind.localeCompare(right.kind);
  });
};

/** One-line chronology for the auditLog: "timeline: <at>=<kind> → …". */
export const summarizeTimeline = (events: TimelineEvent[]): string =>
  `timeline: ${events.map((event) => `${event.at}=${event.kind}`).join(" → ")}`;
