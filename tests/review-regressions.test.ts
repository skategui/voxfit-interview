/**
 * Regression + hardening tests sourced from the adversarial review.
 * Each test pins a behavior that was either a confirmed fix or an under-asserted
 * gap, so it can't silently regress.
 */

import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { buildPostCallDecision } from "../src/decision";
import { extractSignals } from "../src/decision/classify";
import { schedulePaymentReminder } from "../src/decision/schedule";
import {
  AmdStatus,
  CallStatus,
  CaseStatus,
  NormalizedOutcome,
  ReviewReason,
  ScheduledActionType,
  TelephonyKind,
  ToolEventStatus,
} from "../src/decision/types";
import type { ScheduledAction } from "../src/decision/types";
import { makeInput, NOW, PARIS, successPaymentLink } from "./helpers";

const hasReview = (actions: ScheduledAction[]) =>
  actions.some((action) => action.type === ScheduledActionType.ManualReview);
const callRunAt = (actions: ScheduledAction[]) =>
  actions.find((action) => action.type === ScheduledActionType.Call)!.runAt;

describe("precedence pinning", () => {
  it("conflict (Rule 1) beats a sent payment link (Rule 2)", () => {
    // no contact + a human-only outcome + a sent link → still a contradiction → human.
    const decision = buildPostCallDecision(
      makeInput({
        call: { status: CallStatus.NoAnswer, amdStatus: AmdStatus.Unknown },
        insights: { outcome: "Accepted full payment now" },
        toolEvents: [successPaymentLink("2025-07-10T07:59:00+02:00")],
      }),
    );
    expect(decision.normalizedOutcome).toBe(NormalizedOutcome.Unknown);
    expect(
      decision.scheduledActions.find(
        (action) => action.type === ScheduledActionType.ManualReview,
      )?.reason,
    ).toBe(ReviewReason.Conflict);
  });

  it("a derived callback (callbackAt only, no outcome text) also conflicts with no-answer", () => {
    const decision = buildPostCallDecision(
      makeInput({
        call: { status: CallStatus.NoAnswer, amdStatus: AmdStatus.Unknown },
        insights: { outcome: "", callbackAt: "2025-07-15T10:00:00+02:00" },
      }),
    );
    expect(decision.normalizedOutcome).toBe(NormalizedOutcome.Unknown);
  });
});

describe("boundary thresholds", () => {
  it("duration EXACTLY at the 7s threshold is NOT short", () => {
    expect(
      extractSignals(
        makeInput({ call: { durationSec: 7, amdStatus: AmdStatus.Human } }),
      ).telephony,
    ).toBe(TelephonyKind.Ok);
    expect(
      extractSignals(
        makeInput({ call: { durationSec: 6, amdStatus: AmdStatus.Human } }),
      ).telephony,
    ).toBe(TelephonyKind.Short);
  });

  it("stale guard is inclusive: performedAt EXACTLY at the watermark → no-op", () => {
    const watermark = "2025-07-10T07:00:00+02:00";
    const decision = buildPostCallDecision(
      makeInput({
        call: {
          performedAt: watermark,
          status: CallStatus.NoAnswer,
          amdStatus: AmdStatus.Unknown,
        },
        case: { lastDecisionAt: watermark },
        insights: { outcome: "No Answer" },
      }),
    );
    expect(decision.scheduledActions).toHaveLength(0);
  });
});

describe("money safety", () => {
  it("'paid now' with a FAILED payment link → manual_review (no webhook will ever fire)", () => {
    const failedLink = {
      id: "fail",
      name: "send_payment_link",
      status: ToolEventStatus.Failed,
      createdAt: "2025-07-10T07:00:00+02:00",
    };
    const decision = buildPostCallDecision(
      makeInput({
        insights: { outcome: "Accepted full payment now" },
        toolEvents: [failedLink],
      }),
    );
    expect(decision.normalizedOutcome).toBe(
      NormalizedOutcome.WaitPaymentConfirmation,
    );
    expect(hasReview(decision.scheduledActions)).toBe(true);
  });

  it("a completed case yields an empty casePatch (no status churn)", () => {
    const decision = buildPostCallDecision(
      makeInput({
        case: { status: CaseStatus.Completed },
        insights: { outcome: "Debt dispute" },
      }),
    );
    expect(decision.casePatch).toEqual({});
  });
});

describe("scheduling safety", () => {
  it("a rolled-forward past reminder still fires at 09:00 local", () => {
    const warnings: string[] = [];
    const runAt = schedulePaymentReminder(
      "2020-01-01",
      DateTime.fromISO(NOW, { zone: PARIS }),
      PARIS,
      warnings,
    );
    expect(DateTime.fromISO(runAt, { zone: PARIS }).hour).toBe(9);
  });

  it("no callWindow → a 03:00 callback is clamped into business hours (no off-hours dialing)", () => {
    const decision = buildPostCallDecision(
      makeInput({
        insights: {
          outcome: "Call rescheduled",
          callbackAt: "2025-07-15T03:00:00+02:00",
        },
      }),
    );
    const hour = DateTime.fromISO(callRunAt(decision.scheduledActions), {
      zone: PARIS,
    }).hour;
    expect(hour).toBeGreaterThanOrEqual(8);
    expect(hour).toBeLessThan(20);
  });
});
