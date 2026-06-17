/**
 * State-machine transitions: a classified outcome → (case patch + scheduled actions).
 *
 * Pure. One small handler per outcome family, dispatched by applyTransition().
 * Keeping each handler isolated makes the state machine readable and each branch
 * independently testable.
 */

import { DateTime } from "luxon";
import { isValidIso, scheduleCall, schedulePaymentReminder } from "./schedule";
import {
  CaseStatus,
  NormalizedOutcome,
  ReviewReason,
  ScheduledActionType,
  scheduledActionId,
} from "./types";
import type { CasePatch, PostCallInput, ScheduledAction } from "./types";

// --- Constants (tunable; would be per-client config in prod) -----------------
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_PROMISE_FOLLOWUP_DAYS = 3;

// --- Types ------------------------------------------------------------------
export interface Work {
  input: PostCallInput;
  now: DateTime;
  zone: string;
  reviewReason: ReviewReason;
  paymentLinkSent: boolean; // a successful payment-link tool event backs this decision
  warnings: string[];
  audit: string[];
}

export interface OutcomeEffect {
  casePatch: CasePatch;
  scheduledActions: ScheduledAction[];
}

// --- Helpers ----------------------------------------------------------------

/** Build a scheduled action with a deterministic, redelivery-stable id. */
const makeAction = (
  work: Work,
  type: ScheduledActionType,
  runAt: string,
  reason: string,
): ScheduledAction => ({
  id: scheduledActionId(
    work.input.case.caseId,
    work.input.call.callSid,
    type,
    reason,
  ),
  type,
  runAt,
  reason,
});

const makeReview = (work: Work, reason: string): ScheduledAction =>
  makeAction(
    work,
    ScheduledActionType.ManualReview,
    work.now.toUTC().toISO() as string,
    reason,
  );

/** Out of call attempts? `maxAttempts=0` ⇒ exhausted immediately (review). */
const attemptsExhausted = (input: PostCallInput): boolean => {
  const attemptsSoFar = input.step.attemptsSoFar ?? 0;
  const maxAttempts = input.step.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  return attemptsSoFar + 1 >= maxAttempts;
};

const tempExcluded = (
  reason: string,
  nextActionAt: string | null,
  extra: Partial<CasePatch> = {},
): CasePatch => ({
  status: CaseStatus.TempExcluded,
  temporaryExclusionReason: reason,
  nextActionAt,
  ...extra,
});

// --- Handlers ---------------------------------------------------------------

/** do_not_call / wrong_contact → permanent exclusion (terminal). */
const handlePermExclusion = (
  outcome: NormalizedOutcome,
  work: Work,
): OutcomeEffect => {
  const { input, audit } = work;
  const actions: ScheduledAction[] = [];
  // wrong_contact needs a human to find the right number; do_not_call with an
  // outstanding balance needs a human for the write-off / compliance step.
  if (
    outcome === NormalizedOutcome.WrongContact ||
    input.case.amountRemaining > 0
  ) {
    actions.push(makeReview(work, outcome));
    audit.push(`${outcome} with follow-up needed → manual_review`);
  }
  audit.push(`${outcome} → perm_excluded (terminal)`);
  return {
    casePatch: {
      status: CaseStatus.PermExcluded,
      permanentExclusionReason: outcome,
      nextActionAt: null,
    },
    scheduledActions: actions,
  };
};

/** disputed / uncooperative → temp exclusion + a human review. */
const handleHumanQueue = (
  outcome: NormalizedOutcome,
  work: Work,
): OutcomeEffect => {
  work.audit.push(`${outcome} → temp_excluded + manual_review`);
  return {
    casePatch: tempExcluded(outcome, null),
    scheduledActions: [makeReview(work, outcome)],
  };
};

/** promise_to_pay → payment reminder on the date, else a follow-up call. */
const handlePromiseToPay = (work: Work): OutcomeEffect => {
  const { input, now, zone, warnings, audit } = work;
  const paymentDate = input.insights.paymentDate;
  if (paymentDate && isValidIso(paymentDate)) {
    const runAt = schedulePaymentReminder(paymentDate, now, zone, warnings);
    audit.push(
      `promise_to_pay date ${paymentDate} → payment_reminder @ ${runAt}`,
    );
    return {
      casePatch: tempExcluded(NormalizedOutcome.PromiseToPay, runAt, {
        paymentPromiseDate: paymentDate,
      }),
      scheduledActions: [
        makeAction(
          work,
          ScheduledActionType.PaymentReminder,
          runAt,
          NormalizedOutcome.PromiseToPay,
        ),
      ],
    };
  }
  const days =
    input.step.promiseFollowupDelayDays ?? DEFAULT_PROMISE_FOLLOWUP_DAYS;
  if (paymentDate)
    warnings.push(
      `promise_to_pay paymentDate "${paymentDate}" invalid → follow-up call in ${days}d`,
    );
  const runAt = scheduleCall(
    now.plus({ days }).toISO(),
    input,
    now,
    zone,
    warnings,
  );
  audit.push(`promise_to_pay without date → follow-up call @ ${runAt}`);
  return {
    casePatch: tempExcluded(NormalizedOutcome.PromiseToPay, runAt),
    scheduledActions: [
      makeAction(work, ScheduledActionType.Call, runAt, "promise_followup"),
    ],
  };
};

/** wait_payment_confirmation → park; a Stripe webhook completes the case.
 *  But if NO successful payment link was sent (the LLM claimed "paid now" while
 *  the link tool failed or was never invoked), no webhook will ever fire — so we
 *  queue a human to confirm the money instead of stranding the case forever. */
const handleWaitPayment = (work: Work): OutcomeEffect => {
  if (!work.paymentLinkSent) {
    work.warnings.push(
      "wait_payment_confirmation without a successfully-sent link → manual_review safety net",
    );
    work.audit.push(
      "wait_payment_confirmation (no link sent) → temp_excluded + manual_review",
    );
    return {
      casePatch: tempExcluded(NormalizedOutcome.WaitPaymentConfirmation, null),
      scheduledActions: [makeReview(work, "payment_unconfirmed")],
    };
  }
  work.audit.push(
    "wait_payment_confirmation → temp_excluded; Stripe webhook completes the case",
  );
  return {
    casePatch: tempExcluded(NormalizedOutcome.WaitPaymentConfirmation, null),
    scheduledActions: [],
  };
};

/** callback_scheduled → a call at the (clamped) callback time. */
const handleCallback = (work: Work): OutcomeEffect => {
  const runAt = scheduleCall(
    work.input.insights.callbackAt,
    work.input,
    work.now,
    work.zone,
    work.warnings,
  );
  work.audit.push(`callback_scheduled → call @ ${runAt}`);
  return {
    casePatch: tempExcluded(NormalizedOutcome.CallbackScheduled, runAt),
    scheduledActions: [
      makeAction(work, ScheduledActionType.Call, runAt, "callback"),
    ],
  };
};

/** no_answer / voice_mail / early_termination → retry, or give up to a human. */
const handleNoContactFamily = (
  outcome: NormalizedOutcome,
  work: Work,
): OutcomeEffect => {
  const { input, now, zone, warnings, audit } = work;
  if (attemptsExhausted(input)) {
    warnings.push(
      `max attempts reached for ${outcome} → no more calls, manual_review`,
    );
    audit.push(`${outcome} but attempts exhausted → manual_review`);
    return {
      casePatch: tempExcluded(`${outcome}_max_attempts`, null),
      scheduledActions: [makeReview(work, `${outcome}_max_attempts`)],
    };
  }
  const runAt = scheduleCall(undefined, input, now, zone, warnings); // now + retryDelay
  audit.push(`${outcome} → retry call @ ${runAt}`);
  return {
    casePatch: tempExcluded(outcome, runAt),
    scheduledActions: [
      makeAction(work, ScheduledActionType.Call, runAt, `retry_${outcome}`),
    ],
  };
};

/** unknown / conflict → temp exclusion + a human review. */
const handleUnknown = (work: Work): OutcomeEffect => {
  const reason =
    work.reviewReason !== ReviewReason.None
      ? work.reviewReason
      : ReviewReason.UnknownOutcome;
  work.audit.push(`unknown (${reason}) → temp_excluded + manual_review`);
  return {
    casePatch: tempExcluded(reason, null),
    scheduledActions: [makeReview(work, reason)],
  };
};

// --- Dispatcher -------------------------------------------------------------
export const applyTransition = (
  outcome: NormalizedOutcome,
  work: Work,
): OutcomeEffect => {
  switch (outcome) {
    case NormalizedOutcome.DoNotCall:
    case NormalizedOutcome.WrongContact:
      return handlePermExclusion(outcome, work);
    case NormalizedOutcome.Disputed:
    case NormalizedOutcome.Uncooperative:
      return handleHumanQueue(outcome, work);
    case NormalizedOutcome.PromiseToPay:
      return handlePromiseToPay(work);
    case NormalizedOutcome.WaitPaymentConfirmation:
      return handleWaitPayment(work);
    case NormalizedOutcome.CallbackScheduled:
      return handleCallback(work);
    case NormalizedOutcome.NoAnswer:
    case NormalizedOutcome.VoiceMail:
    case NormalizedOutcome.EarlyTermination:
      return handleNoContactFamily(outcome, work);
    case NormalizedOutcome.Unknown:
    default:
      return handleUnknown(work);
  }
};
