/**
 * Edge cases — determinism, event delivery (duplicate / out-of-order / stale),
 * invalid & missing inputs, clock skew, and the most dangerous regression: a
 * happy-looking call must never auto-complete a case whose money is unconfirmed.
 */

import { describe, expect, it } from "vitest";
import { buildPostCallDecision } from "../src/decision";
import {
  AmdStatus,
  CallStatus,
  CaseStatus,
  NormalizedOutcome,
  ScheduledActionType,
  ToolEventStatus,
} from "../src/decision/types";
import { makeInput, NOW, successPaymentLink } from "./helpers";

describe("THE 3am TEST — money is never auto-completed", () => {
  it("connected call + payment link + 'Accepted full payment now' → wait, NOT completed", () => {
    // Most dangerous regression: a naive engine marks this 'completed' though no
    // Stripe webhook has confirmed the money. We must wait.
    const decision = buildPostCallDecision(
      makeInput({
        call: {
          status: CallStatus.Completed,
          amdStatus: AmdStatus.Human,
          durationSec: 90,
        },
        insights: { outcome: "Accepted full payment now" },
        toolEvents: [successPaymentLink("2025-07-10T07:59:00+02:00")],
      }),
    );
    expect(decision.casePatch.status).not.toBe(CaseStatus.Completed);
    expect(decision.normalizedOutcome).toBe(
      NormalizedOutcome.WaitPaymentConfirmation,
    );
  });
});

describe("determinism", () => {
  it("same input → deeply equal Decision (no Date.now / Math.random)", () => {
    const input = makeInput({
      insights: {
        outcome: "Accepted full payment later",
        paymentDate: "2025-07-20",
      },
    });
    expect(buildPostCallDecision(input)).toEqual(buildPostCallDecision(input));
  });

  it("duplicate CallCompleted (same input twice) → identical Decision", () => {
    const input = makeInput({
      call: { status: CallStatus.NoAnswer, amdStatus: AmdStatus.Unknown },
      insights: { outcome: "No Answer" },
    });
    expect(buildPostCallDecision(input)).toEqual(buildPostCallDecision(input));
  });

  it("same events with EQUAL timestamps, array reversed → identical Decision (order-independent)", () => {
    // Regression: tool-event dedupe must order by (createdAt, key), not by input
    // index — otherwise out-of-order delivery of equal-timestamp events reorders
    // the warnings and breaks determinism.
    const sameTimestamp = "2025-07-10T07:00:00+02:00";
    const failedPaymentLink = {
      id: "link",
      name: "send_payment_link",
      status: ToolEventStatus.Failed,
      createdAt: sameTimestamp,
    };
    const failedPlanLink = {
      id: "plan",
      name: "send_payment_plan_link",
      status: ToolEventStatus.Failed,
      createdAt: sameTimestamp,
    };
    const decisionForward = buildPostCallDecision(
      makeInput({
        insights: { outcome: "Debt payment refusal" },
        toolEvents: [failedPaymentLink, failedPlanLink],
      }),
    );
    const decisionReversed = buildPostCallDecision(
      makeInput({
        insights: { outcome: "Debt payment refusal" },
        toolEvents: [failedPlanLink, failedPaymentLink],
      }),
    );
    expect(decisionForward).toEqual(decisionReversed);
  });
});

describe("event delivery — out-of-order / stale", () => {
  it("stale event (performedAt ≤ lastDecisionAt) → no-op, no backward transition", () => {
    const decision = buildPostCallDecision(
      makeInput({
        call: {
          performedAt: "2025-07-10T06:00:00+02:00",
          status: CallStatus.NoAnswer,
          amdStatus: AmdStatus.Unknown,
        },
        case: { lastDecisionAt: "2025-07-10T07:00:00+02:00" }, // newer than the call
        insights: { outcome: "No Answer" },
      }),
    );
    expect(decision.scheduledActions).toHaveLength(0);
    expect(
      decision.warnings.some((message) => message.includes("stale event")),
    ).toBe(true);
  });

  it("fresh event (performedAt > lastDecisionAt) → processed normally", () => {
    const decision = buildPostCallDecision(
      makeInput({
        call: {
          performedAt: "2025-07-10T08:00:00+02:00",
          status: CallStatus.NoAnswer,
          amdStatus: AmdStatus.Unknown,
        },
        case: { lastDecisionAt: "2025-07-10T07:00:00+02:00" },
        insights: { outcome: "No Answer" },
      }),
    );
    expect(decision.scheduledActions.length).toBeGreaterThan(0);
  });
});

describe("invalid / missing inputs", () => {
  it("invalid callbackAt → warns and falls back (still schedules a call)", () => {
    const decision = buildPostCallDecision(
      makeInput({
        insights: { outcome: "Call rescheduled", callbackAt: "nope" },
      }),
    );
    expect(decision.normalizedOutcome).toBe(
      NormalizedOutcome.CallbackScheduled,
    );
    expect(
      decision.scheduledActions.some(
        (action) => action.type === ScheduledActionType.Call,
      ),
    ).toBe(true);
    expect(decision.warnings.length).toBeGreaterThan(0);
  });

  it("invalid `now` → cannot schedule → routes to manual review", () => {
    const decision = buildPostCallDecision(makeInput({ now: "not-a-time" }));
    expect(
      decision.scheduledActions.some(
        (action) => action.reason === "invalid_now",
      ),
    ).toBe(true);
  });

  it("missing optional step fields → uses defaults, still decides", () => {
    const decision = buildPostCallDecision(
      makeInput({
        call: { status: CallStatus.NoAnswer, amdStatus: AmdStatus.Unknown },
        insights: { outcome: "No Answer" },
        step: {
          stepActionId: "S",
          maxAttempts: undefined,
          attemptsSoFar: undefined,
          retryDelayHours: undefined,
        },
      }),
    );
    expect(decision.normalizedOutcome).toBe(NormalizedOutcome.NoAnswer);
    expect(decision.scheduledActions.length).toBeGreaterThan(0);
  });

  it("failed tool event → no state change, surfaced as a warning", () => {
    const failedEvent = {
      id: "fail",
      name: "send_payment_link",
      status: ToolEventStatus.Failed,
      createdAt: "2025-07-10T07:00:00+02:00",
    };
    const decision = buildPostCallDecision(
      makeInput({
        insights: { outcome: "Debt payment refusal" },
        toolEvents: [failedEvent],
      }),
    );
    expect(decision.callPatch.paymentLinkSent).toBeUndefined();
    expect(
      decision.warnings.some((message) => message.includes("failed")),
    ).toBe(true);
  });

  it("future performedAt (clock skew) → warns, still decides", () => {
    const decision = buildPostCallDecision(
      makeInput({
        now: NOW,
        call: {
          performedAt: "2025-07-11T08:00:00+02:00",
          status: CallStatus.NoAnswer,
          amdStatus: AmdStatus.Unknown,
        },
        insights: { outcome: "No Answer" },
      }),
    );
    expect(
      decision.warnings.some((message) => message.includes("future")),
    ).toBe(true);
  });
});
