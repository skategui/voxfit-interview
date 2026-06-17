/**
 * buildPostCallDecision — the pure decision function (public entry point).
 *
 * Pipeline: classify the call → run guards → apply the state transition → assemble.
 * It DECIDES; it never executes. No I/O, no Date.now() (uses `input.now`), so the
 * same input always yields the same Decision (see tests/edge-cases.test.ts).
 *
 * This is ONE transition in a larger event state machine. It does not confirm
 * payments (a Stripe webhook does) nor detect broken promises (a cron does) —
 * see README and src/services/.
 */

import { DateTime } from "luxon";
import { extractSignals, reconcile } from "./classify";
import { evaluateGuards } from "./guards";
import { normalizeOutcomeKey } from "./outcomeMap";
import { parseInZone } from "./schedule";
import { applyTransition } from "./transitions";
import { buildTimeline, summarizeTimeline } from "./timeline";
import { ToolEventStatus } from "./types";
import type { Classification } from "./classify";
import type { GuardContext } from "./guards";
import type {
  CallPatch,
  CasePatch,
  PostCallDecision,
  PostCallInput,
  ScheduledAction,
} from "./types";

interface Context {
  input: PostCallInput;
  now: DateTime | null;
  zone: string;
  warnings: string[];
  audit: string[];
  classification: Classification;
  callPatch: CallPatch;
}

/** Classify the call and build the parts of the result that are always present,
 *  regardless of which guard or transition fires. */
const createContext = (input: PostCallInput): Context => {
  const zone = input.timezone;
  const signals = extractSignals(input);
  const classification = reconcile(signals);
  const warnings: string[] = [];
  // Lead the audit with the reconstructed chronology, then the classification trace.
  const audit: string[] = [
    summarizeTimeline(buildTimeline(input)),
    ...classification.audit,
  ];

  // Failed tool events change no state but must be visible.
  for (const event of signals.dedupedToolEvents) {
    if (event.status === ToolEventStatus.Failed)
      warnings.push(
        `tool event "${event.name}" failed (${event.id ?? "no-id"})`,
      );
  }

  const callPatch: CallPatch = {
    outcome: classification.outcome,
    ...(input.insights.summary !== undefined
      ? { summary: input.insights.summary }
      : {}),
    ...(classification.paymentLinkSent ? { paymentLinkSent: true } : {}),
  };

  return {
    input,
    now: parseInZone(input.now, zone),
    zone,
    warnings,
    audit,
    classification,
    callPatch,
  };
};

const assemble = (
  ctx: Context,
  casePatch: CasePatch,
  scheduledActions: ScheduledAction[],
): PostCallDecision => ({
  normalizedOutcome: ctx.classification.outcome,
  casePatch,
  scheduledActions,
  callPatch: ctx.callPatch,
  warnings: ctx.warnings,
  auditLog: ctx.audit,
});

export const buildPostCallDecision = (
  input: PostCallInput,
): PostCallDecision => {
  const ctx = createContext(input);

  const guardCtx: GuardContext = {
    input: ctx.input,
    now: ctx.now,
    zone: ctx.zone,
    outcome: ctx.classification.outcome,
    warnings: ctx.warnings,
    audit: ctx.audit,
  };
  const blocked = evaluateGuards(guardCtx);
  if (blocked)
    return assemble(ctx, blocked.casePatch, blocked.scheduledActions);

  // Guards guarantee a usable clock past this point.
  const now = ctx.now as DateTime;
  const effect = applyTransition(ctx.classification.outcome, {
    input: ctx.input,
    now,
    zone: ctx.zone,
    reviewReason: ctx.classification.reviewReason,
    paymentLinkSent: ctx.classification.paymentLinkSent,
    warnings: ctx.warnings,
    audit: ctx.audit,
  });
  return assemble(ctx, effect.casePatch, effect.scheduledActions);
};

// --- Re-exports for consumers / tests --------------------------------------
export * from "./types";
export { classify, extractSignals, reconcile } from "./classify";
export { applyTransition } from "./transitions";
export { evaluateGuards } from "./guards";
export { buildPromiseExpiryDecision } from "./promiseExpiry";
export { normalizeOutcomeKey };
export type { ExtractedSignals, Classification } from "./classify";
export type {
  PromiseExpiryInput,
  PromiseExpiryDecision,
} from "./promiseExpiry";
