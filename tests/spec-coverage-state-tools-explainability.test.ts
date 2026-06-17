/**
 * Spec-coverage matrix (part 2/2): §4 Case State, §5 Tool Events, §6 Explainability,
 * and the brief's "Edge Cases To Consider". One describe per spec section, one `it`
 * per rule, quoting the rule text — so coverage of the brief is visible 1:1.
 * Telephony/mapping/scheduling are in spec-coverage-telephony-mapping-scheduling.test.ts.
 */

import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { buildPostCallDecision } from "../src/decision";
import {
  AmdStatus,
  CallStatus,
  CallWindowDay,
  CaseStatus,
  NormalizedOutcome,
  ScheduledActionType,
  ToolEventStatus,
} from "../src/decision/types";
import type { ScheduledAction, ToolEvent } from "../src/decision/types";
import { makeInput, PARIS, successPaymentLink } from "./helpers";

const inParis = (iso: string) => DateTime.fromISO(iso, { zone: PARIS });
const hasAction = (actions: ScheduledAction[], type: ScheduledActionType) =>
  actions.some((action) => action.type === type);
const findCall = (actions: ScheduledAction[]) =>
  actions.find((action) => action.type === ScheduledActionType.Call)!;

describe("Spec §4 — Case State", () => {
  it("do_not_call and wrong_contact → perm_excluded", () => {
    expect(
      buildPostCallDecision(
        makeInput({ insights: { outcome: "Stop contact" } }),
      ).casePatch.status,
    ).toBe(CaseStatus.PermExcluded);
    expect(
      buildPostCallDecision(
        makeInput({ insights: { outcome: "Incorrect contact information" } }),
      ).casePatch.status,
    ).toBe(CaseStatus.PermExcluded);
  });

  it("future-action outcomes → temp_excluded", () => {
    const scenarios: Array<Parameters<typeof makeInput>[0]> = [
      {
        insights: {
          outcome: "Call rescheduled",
          callbackAt: "2025-07-15T10:00:00+02:00",
        },
      },
      {
        insights: {
          outcome: "Accepted full payment later",
          paymentDate: "2025-07-20",
        },
      },
      { toolEvents: [successPaymentLink("2025-07-10T07:00:00+02:00")] }, // wait_payment_confirmation
      { insights: { outcome: "Debt dispute" } },
      { insights: { outcome: "Debt payment refusal" } },
      {
        call: { status: CallStatus.NoAnswer, amdStatus: AmdStatus.Unknown },
        insights: { outcome: "No Answer" },
      },
      {
        call: { amdStatus: AmdStatus.MachineStart },
        insights: { outcome: "" },
      }, // voice_mail
    ];
    for (const scenario of scenarios) {
      expect(buildPostCallDecision(makeInput(scenario)).casePatch.status).toBe(
        CaseStatus.TempExcluded,
      );
    }
  });

  it("max attempts reached after no-answer → no new call, a manual_review instead", () => {
    const decision = buildPostCallDecision(
      makeInput({
        call: { status: CallStatus.NoAnswer, amdStatus: AmdStatus.Unknown },
        insights: { outcome: "No Answer" },
        step: { attemptsSoFar: 5, maxAttempts: 5 },
      }),
    );
    expect(hasAction(decision.scheduledActions, ScheduledActionType.Call)).toBe(
      false,
    );
    expect(
      hasAction(decision.scheduledActions, ScheduledActionType.ManualReview),
    ).toBe(true);
  });
});

describe("Spec §5 — Tool Events", () => {
  it("a successful send_payment_link → paymentLinkSent: true", () => {
    const decision = buildPostCallDecision(
      makeInput({
        toolEvents: [successPaymentLink("2025-07-10T07:00:00+02:00")],
      }),
    );
    expect(decision.callPatch.paymentLinkSent).toBe(true);
  });

  it("a successful send_payment_plan_link → paymentLinkSent: true + wait_payment_confirmation", () => {
    const planLinkEvent: ToolEvent = {
      id: "plan",
      name: "send_payment_plan_link",
      status: ToolEventStatus.Success,
      createdAt: "2025-07-10T07:00:00+02:00",
    };
    const decision = buildPostCallDecision(
      makeInput({ toolEvents: [planLinkEvent] }),
    );
    expect(decision.callPatch.paymentLinkSent).toBe(true);
    expect(decision.normalizedOutcome).toBe(
      NormalizedOutcome.WaitPaymentConfirmation,
    );
  });

  it("a failed tool event → no state change, surfaced in warnings", () => {
    const failedEvent: ToolEvent = {
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

  it("duplicate tool events → no duplicate scheduled actions", () => {
    const linkEvent = successPaymentLink("2025-07-10T07:00:00+02:00", "dup");
    const singleEvent = buildPostCallDecision(
      makeInput({ toolEvents: [linkEvent] }),
    );
    const tripledEvent = buildPostCallDecision(
      makeInput({
        toolEvents: [linkEvent, { ...linkEvent }, { ...linkEvent }],
      }),
    );
    expect(tripledEvent.scheduledActions).toEqual(singleEvent.scheduledActions);
    expect(tripledEvent.callPatch.paymentLinkSent).toBe(true);
  });
});

describe("Spec §6 — Explainability", () => {
  it("auditLog explains the decision (signals + the rule that fired)", () => {
    const decision = buildPostCallDecision(
      makeInput({ insights: { outcome: "Debt dispute" } }),
    );
    expect(decision.auditLog.length).toBeGreaterThanOrEqual(2);
    expect(decision.auditLog.some((line) => line.startsWith("signals:"))).toBe(
      true,
    );
    expect(decision.auditLog.some((line) => line.includes("disputed"))).toBe(
      true,
    );
  });
});

describe("Spec — Edge cases", () => {
  it("conflicting signals (no-answer + 'payment accepted') → manual_review", () => {
    const decision = buildPostCallDecision(
      makeInput({
        call: { status: CallStatus.NoAnswer, amdStatus: AmdStatus.Unknown },
        insights: { outcome: "Accepted full payment now" },
      }),
    );
    expect(
      hasAction(decision.scheduledActions, ScheduledActionType.ManualReview),
    ).toBe(true);
  });

  it("already permanently excluded case → no action", () => {
    expect(
      buildPostCallDecision(
        makeInput({ case: { status: CaseStatus.PermExcluded } }),
      ).scheduledActions,
    ).toHaveLength(0);
  });

  it("boundary: callback exactly at window START is allowed (kept)", () => {
    const decision = buildPostCallDecision(
      makeInput({
        insights: {
          outcome: "Call rescheduled",
          callbackAt: "2025-07-10T10:00:00+02:00",
        },
        step: {
          callWindow: {
            days: [CallWindowDay.Thu],
            start: "10:00",
            end: "12:00",
          },
        },
      }),
    );
    const callAction = findCall(decision.scheduledActions);
    expect(inParis(callAction.runAt).hour).toBe(10);
    expect(inParis(callAction.runAt).toISODate()).toBe("2025-07-10");
  });

  it("boundary: callback exactly at window END is pushed out (end is exclusive)", () => {
    const decision = buildPostCallDecision(
      makeInput({
        insights: {
          outcome: "Call rescheduled",
          callbackAt: "2025-07-10T12:00:00+02:00",
        },
        step: {
          callWindow: {
            days: [CallWindowDay.Thu],
            start: "10:00",
            end: "12:00",
          },
        },
      }),
    );
    const callAction = findCall(decision.scheduledActions);
    expect(inParis(callAction.runAt).hour).toBe(10); // rolled to the next allowed day's window start
    expect(inParis(callAction.runAt).toISODate()).not.toBe("2025-07-10");
  });
});
