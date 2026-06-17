/**
 * Unhonored payment promise → relaunch (or give up to a human).
 *
 * This is the SECOND entry point into the engine, fired by a TIMER, not a call:
 * when a `paymentPromiseDate` lapses, a cron emits a `PromiseExpired` event and
 * the orchestrator calls this pure function with the LIVE case state.
 *
 * The payment lifecycle it closes:
 *   PROMISE_TO_PAY → (deadline passes) → DEADLINE_EXPIRED
 *        ├─ amountRemaining ≤ 0  → PAID (honored late / before the timer) → completed, NO relaunch
 *        ├─ attempts remain      → RELAUNCH (a fresh call)
 *        └─ attempts exhausted   → manual_review (kills the infinite-relaunch loop)
 *
 * Reading the live `amountRemaining` is the key: a payment received *before* the
 * relaunch fires means we complete instead of re-dialing a debtor who already paid.
 */

import { parseInZone, scheduleCall } from "./schedule";
import { CaseStatus, ScheduledActionType, scheduledActionId } from "./types";
import type { CaseInfo, CasePatch, ScheduledAction, StepInfo } from "./types";

const DEFAULT_MAX_ATTEMPTS = 5;

export interface PromiseExpiryInput {
  now: string; // ISO — authoritative clock
  timezone: string;
  /** LIVE case state: amountRemaining reflects any payment already received. */
  case: CaseInfo;
  step: StepInfo;
  /** Id of the call/promise that made the commitment — for action dedupe. */
  promiseId: string;
  /** The promised date that just lapsed (audit only). */
  promiseDate: string;
}

export interface PromiseExpiryDecision {
  casePatch: CasePatch;
  scheduledActions: ScheduledAction[];
  warnings: string[];
  auditLog: string[];
}

export const buildPromiseExpiryDecision = (
  input: PromiseExpiryInput,
): PromiseExpiryDecision => {
  const warnings: string[] = [];
  const audit: string[] = [
    `promise expiry: promiseDate=${input.promiseDate}, amountRemaining=${input.case.amountRemaining}, status=${input.case.status}`,
  ];
  const action = (
    type: ScheduledActionType,
    runAt: string,
    reason: string,
  ): ScheduledAction => ({
    id: scheduledActionId(input.case.caseId, input.promiseId, type, reason),
    type,
    runAt,
    reason,
  });
  const done = (
    casePatch: CasePatch,
    scheduledActions: ScheduledAction[],
  ): PromiseExpiryDecision => ({
    casePatch,
    scheduledActions,
    warnings,
    auditLog: audit,
  });

  // 1. Terminal case → the promise is moot. Idempotent: a double-fired timer no-ops.
  if (
    input.case.status === CaseStatus.PermExcluded ||
    input.case.status === CaseStatus.Completed
  ) {
    audit.push(`case already ${input.case.status} → no action`);
    return done({}, []);
  }

  // 2. PAID (late, or before this timer) → promise honored → completed, never relaunch.
  if (
    Number.isFinite(input.case.amountRemaining) &&
    input.case.amountRemaining <= 0
  ) {
    audit.push(
      "amountRemaining ≤ 0 → promise honored (paid) → completed; no relaunch",
    );
    return done({ status: CaseStatus.Completed, nextActionAt: null }, []);
  }

  const now = parseInZone(input.now, input.timezone);
  if (!now) {
    warnings.push(
      `invalid now "${input.now}" → cannot schedule, manual_review`,
    );
    return done(
      {
        status: CaseStatus.TempExcluded,
        temporaryExclusionReason: "promise_broken",
        nextActionAt: null,
      },
      [
        action(
          ScheduledActionType.ManualReview,
          input.now,
          "promise_broken_invalid_now",
        ),
      ],
    );
  }

  // 3. Promise BROKEN (money still owed). Cap relaunches → no infinite loop.
  const attemptsSoFar = input.step.attemptsSoFar ?? 0;
  const maxAttempts = input.step.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (attemptsSoFar + 1 >= maxAttempts) {
    warnings.push(
      "promise broken AND attempts exhausted → manual_review (no infinite relaunch)",
    );
    audit.push("promise broken; attempts exhausted → manual_review");
    return done(
      {
        status: CaseStatus.TempExcluded,
        temporaryExclusionReason: "promise_broken_max_attempts",
        nextActionAt: null,
      },
      [
        action(
          ScheduledActionType.ManualReview,
          now.toUTC().toISO() as string,
          "promise_broken_max_attempts",
        ),
      ],
    );
  }

  // RELAUNCH — a fresh call, parked until it fires (clamped to the call window).
  const runAt = scheduleCall(undefined, input, now, input.timezone, warnings);
  audit.push(`PROMISE_TO_PAY → DEADLINE_EXPIRED → RELAUNCH: call @ ${runAt}`);
  return done(
    {
      status: CaseStatus.TempExcluded,
      temporaryExclusionReason: "promise_broken_relaunch",
      nextActionAt: runAt,
    },
    [action(ScheduledActionType.Call, runAt, "promise_broken_relaunch")],
  );
};
