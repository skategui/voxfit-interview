/**
 * Pre-classification guards: short-circuit cases where we must NOT run the normal
 * state machine. Each guard is pure and returns either a terminal effect
 * (casePatch + scheduledActions) or null ("not my case, continue").
 *
 * Order matters and is fixed by evaluateGuards():
 *   1. invalid clock      → cannot schedule → human review
 *   2. terminal case      → idempotent no-op (never resurrect)
 *   3. nothing to collect → completed
 *   4. stale/out-of-order → no-op (no backward transition)
 */

import { DateTime } from "luxon";
import { isValidIso, parseInZone } from "./schedule";
import {
  CaseStatus,
  NormalizedOutcome,
  ScheduledActionType,
  scheduledActionId,
} from "./types";
import type { CasePatch, PostCallInput, ScheduledAction } from "./types";

export interface GuardContext {
  input: PostCallInput;
  now: DateTime | null;
  zone: string;
  /** The already-classified outcome. Lets a guard yield to a stronger transition
   *  (e.g. a compliance do_not_call must win over "settled"). */
  outcome: NormalizedOutcome;
  warnings: string[];
  audit: string[];
}

export interface GuardOutcome {
  casePatch: CasePatch;
  scheduledActions: ScheduledAction[];
}

/** 1. The clock is unusable → we cannot schedule anything safely → route to a human. */
const invalidClockGuard = (ctx: GuardContext): GuardOutcome | null => {
  if (ctx.now) return null;
  ctx.warnings.push(
    `invalid now "${ctx.input.now}" → cannot schedule, routing to manual review`,
  );
  return {
    casePatch: {},
    scheduledActions: [
      {
        id: scheduledActionId(
          ctx.input.case.caseId,
          ctx.input.call.callSid,
          ScheduledActionType.ManualReview,
          "invalid_now",
        ),
        type: ScheduledActionType.ManualReview,
        runAt: ctx.input.now,
        reason: "invalid_now",
      },
    ],
  };
};

/** 2. Case already terminal → no action. Idempotent; never resurrect. */
const terminalCaseGuard = (ctx: GuardContext): GuardOutcome | null => {
  const status = ctx.input.case.status;
  if (status !== CaseStatus.PermExcluded && status !== CaseStatus.Completed)
    return null;
  ctx.audit.push(`case already ${status} → no action (terminal)`);
  return { casePatch: {}, scheduledActions: [] };
};

/** 3. Nothing left to collect → mark completed. Never dun a settled customer. */
const settledGuard = (ctx: GuardContext): GuardOutcome | null => {
  // Compliance outcomes win over "settled": a do_not_call / wrong_contact must
  // still permanently exclude (and keep that reason) even when nothing is owed —
  // otherwise we silently drop the DNC / suppression marker.
  if (
    ctx.outcome === NormalizedOutcome.DoNotCall ||
    ctx.outcome === NormalizedOutcome.WrongContact
  )
    return null;

  const remaining = ctx.input.case.amountRemaining;
  // A non-finite amount (NaN / undefined / non-numeric that slipped past the parser)
  // is a MALFORMED payload, not a settled case. Completing here would silently stop
  // collection on a live debt — the most dangerous failure. Flag loudly and proceed.
  if (!Number.isFinite(remaining)) {
    ctx.warnings.push(
      `amountRemaining is not a finite number (${String(remaining)}) → NOT treating as settled`,
    );
    return null;
  }
  if (remaining > 0) return null;
  ctx.audit.push(
    `amountRemaining ${remaining} ≤ 0 → completed (already settled)`,
  );
  return {
    casePatch: { status: CaseStatus.Completed, nextActionAt: null },
    scheduledActions: [],
  };
};

/** 4. Stale / out-of-order event (older than the case watermark) → no-op. */
const staleEventGuard = (ctx: GuardContext): GuardOutcome | null => {
  const watermark = ctx.input.case.lastDecisionAt;
  if (!watermark || !isValidIso(watermark) || !ctx.now) return null;

  const performedAt = parseInZone(ctx.input.call.performedAt, ctx.zone);
  const mark = parseInZone(watermark, ctx.zone);
  if (!performedAt || !mark || performedAt > mark) return null;

  ctx.warnings.push(
    `stale event: performedAt ${ctx.input.call.performedAt} ≤ lastDecisionAt ${watermark} → no-op`,
  );
  ctx.audit.push("stale/out-of-order event ignored (no backward transition)");
  return { casePatch: {}, scheduledActions: [] };
};

/** Non-blocking: warn on clock skew (we always anchor scheduling on `now`). */
const noteClockSkew = (ctx: GuardContext): void => {
  if (!ctx.now) return;
  const performedAt = parseInZone(ctx.input.call.performedAt, ctx.zone);
  if (performedAt && performedAt > ctx.now) {
    ctx.warnings.push(
      "call.performedAt is in the future relative to now → anchoring on now",
    );
  }
};

const GUARDS: ReadonlyArray<(ctx: GuardContext) => GuardOutcome | null> = [
  invalidClockGuard,
  terminalCaseGuard,
  settledGuard,
  staleEventGuard,
];

/** Run all guards in order. Returns the first terminal effect, or null to proceed. */
export const evaluateGuards = (ctx: GuardContext): GuardOutcome | null => {
  noteClockSkew(ctx);
  for (const guard of GUARDS) {
    const outcome = guard(ctx);
    if (outcome) return outcome;
  }
  return null;
};
