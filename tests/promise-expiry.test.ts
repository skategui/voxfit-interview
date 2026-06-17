/**
 * Unhonored-promise → relaunch tests (the timer/PromiseExpired entry point).
 * Covers the payment lifecycle: paid-late → completed, broken → relaunch (capped),
 * cap reached → manual_review, terminal/idempotent, and orchestrator routing.
 */

import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { buildPromiseExpiryDecision } from "../src/decision";
import type { PromiseExpiryInput } from "../src/decision";
import { CaseStatus, ScheduledActionType } from "../src/decision/types";
import type { ScheduledAction } from "../src/decision/types";
import { handlePromiseExpired } from "../src/services/orchestrator";
import { ManualReviewStore } from "../src/services/manualReview";
import { NOW, PARIS } from "./helpers";

interface PromiseOverrides {
  now?: string;
  case?: Partial<PromiseExpiryInput["case"]>;
  step?: Partial<PromiseExpiryInput["step"]>;
}

const makePromiseInput = (
  overrides: PromiseOverrides = {},
): PromiseExpiryInput => ({
  now: overrides.now ?? NOW,
  timezone: PARIS,
  case: {
    caseId: "CASE_1",
    status: CaseStatus.TempExcluded,
    amountRemaining: 100,
    currency: "EUR",
    ...overrides.case,
  },
  step: {
    stepActionId: "STEP_1",
    attemptsSoFar: 0,
    maxAttempts: 5,
    retryDelayHours: 24,
    ...overrides.step,
  },
  promiseId: "CA_promise",
  promiseDate: "2025-07-09",
});

const has = (actions: ScheduledAction[], type: ScheduledActionType) =>
  actions.some((action) => action.type === type);

describe("buildPromiseExpiryDecision", () => {
  it("PAID before the timer (amountRemaining ≤ 0) → completed, NO relaunch", () => {
    // The single most important case: never re-dial a debtor who already paid.
    const decision = buildPromiseExpiryDecision(
      makePromiseInput({ case: { amountRemaining: 0 } }),
    );
    expect(decision.casePatch.status).toBe(CaseStatus.Completed);
    expect(decision.scheduledActions).toHaveLength(0);
  });

  it("promise broken, attempts remain → RELAUNCH (a fresh call)", () => {
    const decision = buildPromiseExpiryDecision(
      makePromiseInput({ step: { attemptsSoFar: 0, maxAttempts: 5 } }),
    );
    expect(decision.casePatch.status).toBe(CaseStatus.TempExcluded);
    const call = decision.scheduledActions.find(
      (action) => action.type === ScheduledActionType.Call,
    );
    expect(call?.reason).toBe("promise_broken_relaunch");
  });

  it("promise broken AND attempts exhausted → manual_review (no infinite relaunch loop)", () => {
    const decision = buildPromiseExpiryDecision(
      makePromiseInput({ step: { attemptsSoFar: 5, maxAttempts: 5 } }),
    );
    expect(has(decision.scheduledActions, ScheduledActionType.Call)).toBe(
      false,
    );
    expect(
      has(decision.scheduledActions, ScheduledActionType.ManualReview),
    ).toBe(true);
  });

  it("a relaunch call is clamped into business hours", () => {
    const decision = buildPromiseExpiryDecision(makePromiseInput());
    const call = decision.scheduledActions.find(
      (action) => action.type === ScheduledActionType.Call,
    )!;
    const hour = DateTime.fromISO(call.runAt, { zone: PARIS }).hour;
    expect(hour).toBeGreaterThanOrEqual(8);
    expect(hour).toBeLessThan(20);
  });

  it("terminal case (completed / perm_excluded) → no action (idempotent double-fire)", () => {
    expect(
      buildPromiseExpiryDecision(
        makePromiseInput({ case: { status: CaseStatus.Completed } }),
      ).scheduledActions,
    ).toHaveLength(0);
    expect(
      buildPromiseExpiryDecision(
        makePromiseInput({ case: { status: CaseStatus.PermExcluded } }),
      ).scheduledActions,
    ).toHaveLength(0);
  });

  it("invalid `now` → manual_review (cannot schedule a relaunch safely)", () => {
    const decision = buildPromiseExpiryDecision(
      makePromiseInput({ now: "not-a-time" }),
    );
    expect(
      decision.scheduledActions.some(
        (action) => action.reason === "promise_broken_invalid_now",
      ),
    ).toBe(true);
  });

  it("is deterministic (same input → deeply equal decision)", () => {
    const input = makePromiseInput({
      step: { attemptsSoFar: 5, maxAttempts: 5 },
    });
    expect(buildPromiseExpiryDecision(input)).toEqual(
      buildPromiseExpiryDecision(input),
    );
  });
});

describe("orchestrator handlePromiseExpired", () => {
  it("routes a broken-promise review into the store, idempotently", () => {
    const store = new ManualReviewStore(null);
    const input = makePromiseInput({
      step: { attemptsSoFar: 5, maxAttempts: 5 },
    });

    const first = handlePromiseExpired(input, store);
    expect(first.enqueued).toHaveLength(1);
    expect(first.enqueued[0]?.reason).toBe("promise_broken_max_attempts");

    const second = handlePromiseExpired(input, store); // re-delivered timer event
    expect(second.enqueued).toHaveLength(0);
    expect(store.size()).toBe(1);
  });

  it("a relaunch (non-review) enqueues nothing", () => {
    const store = new ManualReviewStore(null);
    const result = handlePromiseExpired(makePromiseInput(), store);
    expect(result.enqueued).toHaveLength(0);
    expect(store.size()).toBe(0);
  });
});
