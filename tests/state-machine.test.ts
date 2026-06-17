/**
 * State-machine tests — guards (terminal / settled) and every outcome transition.
 * Asserts the casePatch status + which scheduled actions are emitted, encoding the
 * business intent (e.g. money is never auto-completed, disputes always go to a human).
 */

import { describe, expect, it } from "vitest";
import { buildPostCallDecision } from "../src/decision";
import {
  AmdStatus,
  CallStatus,
  CaseStatus,
  NormalizedOutcome,
  ScheduledActionType,
} from "../src/decision/types";
import type { ScheduledAction } from "../src/decision/types";
import { makeInput, successPaymentLink } from "./helpers";

const hasAction = (actions: ScheduledAction[], type: ScheduledActionType) =>
  actions.some((action) => action.type === type);

describe("guards", () => {
  it("perm_excluded case → no action (idempotent, never resurrect)", () => {
    const decision = buildPostCallDecision(
      makeInput({ case: { status: CaseStatus.PermExcluded } }),
    );
    expect(decision.casePatch.status).toBeUndefined();
    expect(decision.scheduledActions).toHaveLength(0);
  });

  it("completed case → no action", () => {
    const decision = buildPostCallDecision(
      makeInput({ case: { status: CaseStatus.Completed } }),
    );
    expect(decision.scheduledActions).toHaveLength(0);
  });

  it("amountRemaining ≤ 0 → completed, no dunning", () => {
    const decision = buildPostCallDecision(
      makeInput({
        case: { amountRemaining: 0 },
        insights: { outcome: "Debt payment refusal" },
      }),
    );
    expect(decision.casePatch.status).toBe(CaseStatus.Completed);
    expect(decision.scheduledActions).toHaveLength(0);
  });
});

describe("permanent exclusions", () => {
  it("Stop contact → perm_excluded + manual_review for the outstanding balance", () => {
    const decision = buildPostCallDecision(
      makeInput({ insights: { outcome: "Stop contact" } }),
    );
    expect(decision.normalizedOutcome).toBe(NormalizedOutcome.DoNotCall);
    expect(decision.casePatch.status).toBe(CaseStatus.PermExcluded);
    expect(decision.casePatch.permanentExclusionReason).toBe(
      NormalizedOutcome.DoNotCall,
    );
    expect(
      hasAction(decision.scheduledActions, ScheduledActionType.ManualReview),
    ).toBe(true);
  });

  it("Incorrect contact information → perm_excluded + manual_review (find right number)", () => {
    const decision = buildPostCallDecision(
      makeInput({ insights: { outcome: "Incorrect contact information" } }),
    );
    expect(decision.casePatch.status).toBe(CaseStatus.PermExcluded);
    expect(
      hasAction(decision.scheduledActions, ScheduledActionType.ManualReview),
    ).toBe(true);
  });
});

describe("human-queue outcomes", () => {
  it("Debt dispute → temp_excluded + manual_review (legal/chargeback)", () => {
    const decision = buildPostCallDecision(
      makeInput({ insights: { outcome: "Debt dispute" } }),
    );
    expect(decision.normalizedOutcome).toBe(NormalizedOutcome.Disputed);
    expect(decision.casePatch.status).toBe(CaseStatus.TempExcluded);
    expect(
      hasAction(decision.scheduledActions, ScheduledActionType.ManualReview),
    ).toBe(true);
  });

  it("Debt payment refusal → uncooperative → manual_review (default policy)", () => {
    const decision = buildPostCallDecision(
      makeInput({ insights: { outcome: "Debt payment refusal" } }),
    );
    expect(decision.normalizedOutcome).toBe(NormalizedOutcome.Uncooperative);
    expect(
      hasAction(decision.scheduledActions, ScheduledActionType.ManualReview),
    ).toBe(true);
  });

  it("unknown outcome → manual_review", () => {
    const decision = buildPostCallDecision(
      makeInput({ insights: { outcome: "totally novel label" } }),
    );
    expect(decision.normalizedOutcome).toBe(NormalizedOutcome.Unknown);
    expect(
      hasAction(decision.scheduledActions, ScheduledActionType.ManualReview),
    ).toBe(true);
  });
});

describe("promise to pay", () => {
  it("with a date → payment_reminder + records paymentPromiseDate", () => {
    const decision = buildPostCallDecision(
      makeInput({
        insights: {
          outcome: "Accepted full payment later",
          paymentDate: "2025-07-20",
        },
      }),
    );
    expect(decision.normalizedOutcome).toBe(NormalizedOutcome.PromiseToPay);
    expect(decision.casePatch.paymentPromiseDate).toBe("2025-07-20");
    expect(
      hasAction(decision.scheduledActions, ScheduledActionType.PaymentReminder),
    ).toBe(true);
  });

  it("without a date → a follow-up call instead", () => {
    const decision = buildPostCallDecision(
      makeInput({ insights: { outcome: "Accepted payment plan later" } }),
    );
    expect(decision.normalizedOutcome).toBe(NormalizedOutcome.PromiseToPay);
    expect(hasAction(decision.scheduledActions, ScheduledActionType.Call)).toBe(
      true,
    );
  });
});

describe("payment link + callback", () => {
  it("wait_payment_confirmation schedules NOTHING (webhook owns completion)", () => {
    const decision = buildPostCallDecision(
      makeInput({
        toolEvents: [successPaymentLink("2025-07-10T07:00:00+02:00")],
      }),
    );
    expect(decision.normalizedOutcome).toBe(
      NormalizedOutcome.WaitPaymentConfirmation,
    );
    expect(decision.casePatch.status).toBe(CaseStatus.TempExcluded);
    expect(decision.scheduledActions).toHaveLength(0);
    expect(decision.callPatch.paymentLinkSent).toBe(true);
  });

  it("Call rescheduled → a call action", () => {
    const decision = buildPostCallDecision(
      makeInput({
        insights: {
          outcome: "Call rescheduled",
          callbackAt: "2025-07-15T10:00:00+02:00",
        },
      }),
    );
    expect(decision.normalizedOutcome).toBe(
      NormalizedOutcome.CallbackScheduled,
    );
    expect(hasAction(decision.scheduledActions, ScheduledActionType.Call)).toBe(
      true,
    );
  });
});

describe("no-answer family — retry vs give up", () => {
  const noAnswerDecision = (attemptsSoFar: number, maxAttempts: number) =>
    buildPostCallDecision(
      makeInput({
        call: { status: CallStatus.NoAnswer, amdStatus: AmdStatus.Unknown },
        insights: { outcome: "No Answer" },
        step: { attemptsSoFar, maxAttempts },
      }),
    );

  it("retries while attempts remain", () => {
    const decision = noAnswerDecision(0, 5);
    expect(hasAction(decision.scheduledActions, ScheduledActionType.Call)).toBe(
      true,
    );
    expect(
      hasAction(decision.scheduledActions, ScheduledActionType.ManualReview),
    ).toBe(false);
  });

  it("stops and escalates to a human at the attempt cap", () => {
    const decision = noAnswerDecision(4, 5); // this is the 5th attempt
    expect(hasAction(decision.scheduledActions, ScheduledActionType.Call)).toBe(
      false,
    );
    expect(
      hasAction(decision.scheduledActions, ScheduledActionType.ManualReview),
    ).toBe(true);
  });

  it("maxAttempts = 0 → straight to manual_review", () => {
    const decision = noAnswerDecision(0, 0);
    expect(
      hasAction(decision.scheduledActions, ScheduledActionType.ManualReview),
    ).toBe(true);
    expect(hasAction(decision.scheduledActions, ScheduledActionType.Call)).toBe(
      false,
    );
  });
});
