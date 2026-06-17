/**
 * Orchestrator — the event-driven glue around the pure decision functions.
 *
 * Two entry points, one per event source:
 *   - `handleCallCompleted`  ← a CallCompleted event
 *   - `handlePromiseExpired` ← a timer/cron PromiseExpired event (broken promise)
 *
 * Both run a pure decision function, then ROUTE any `manual_review` scheduled
 * action to the ManualReview store + bus. The decision functions never touch the
 * store or the bus — that separation is the whole point (pure core, stateful edge).
 * Applying the casePatch and executing call/payment_reminder actions belong to the
 * CaseStore and Scheduler (not built here; named in the README).
 */

import { buildPostCallDecision } from "../decision";
import { buildPromiseExpiryDecision } from "../decision/promiseExpiry";
import { NormalizedOutcome, ScheduledActionType } from "../decision/types";
import type { ScheduledAction } from "../decision/types";
import type { PromiseExpiryInput } from "../decision/promiseExpiry";
import { bus } from "./bus";
import { ManualReviewStore, ReviewStatus, reviewItemId } from "./manualReview";
import type { ManualReviewItem } from "./manualReview";

export interface RouteResult {
  enqueued: ManualReviewItem[];
}

/** Route every manual_review action in `actions` into the store (idempotently)
 *  and onto the bus. `buildItem` turns an action into a store row. */
const routeReviews = (
  actions: ScheduledAction[],
  store: ManualReviewStore,
  buildItem: (action: ScheduledAction) => ManualReviewItem,
): ManualReviewItem[] => {
  const enqueued: ManualReviewItem[] = [];
  for (const action of actions) {
    if (action.type !== ScheduledActionType.ManualReview) continue;
    const item = buildItem(action);
    if (store.enqueue(item)) {
      enqueued.push(item);
      bus.emit("manual_review.requested", item);
    }
  }
  return enqueued;
};

// --- CallCompleted ----------------------------------------------------------

export interface HandleCallResult extends RouteResult {
  decision: ReturnType<typeof buildPostCallDecision>;
}

export const handleCallCompleted = (
  input: Parameters<typeof buildPostCallDecision>[0],
  store: ManualReviewStore,
): HandleCallResult => {
  const decision = buildPostCallDecision(input);
  const enqueued = routeReviews(decision.scheduledActions, store, (action) => ({
    id: reviewItemId(input.case.caseId, input.call.callSid, action.reason),
    caseId: input.case.caseId,
    callSid: input.call.callSid,
    reason: action.reason,
    normalizedOutcome: decision.normalizedOutcome,
    warnings: decision.warnings,
    createdAt: input.now, // deterministic — no Date.now()
    status: ReviewStatus.Open,
    // Attach the transcript when present — the human investigator's source of truth.
    ...(input.insights.transcript
      ? { transcript: input.insights.transcript }
      : {}),
  }));
  return { decision, enqueued };
};

// --- PromiseExpired (broken promise) ----------------------------------------

export interface HandlePromiseResult extends RouteResult {
  decision: ReturnType<typeof buildPromiseExpiryDecision>;
}

export const handlePromiseExpired = (
  input: PromiseExpiryInput,
  store: ManualReviewStore,
): HandlePromiseResult => {
  const decision = buildPromiseExpiryDecision(input);
  const enqueued = routeReviews(decision.scheduledActions, store, (action) => ({
    id: reviewItemId(input.case.caseId, input.promiseId, action.reason),
    caseId: input.case.caseId,
    callSid: input.promiseId,
    reason: action.reason,
    normalizedOutcome: NormalizedOutcome.PromiseToPay, // context: a broken promise
    warnings: decision.warnings,
    createdAt: input.now,
    status: ReviewStatus.Open,
  }));
  return { decision, enqueued };
};
