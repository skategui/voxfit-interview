/**
 * Spec-coverage matrix (part 1/2): §1 Telephony, §2 Outcome Mapping, §3 Scheduling.
 * One describe per spec section, one `it` per rule, quoting the rule text — so
 * coverage of the brief is visible 1:1. State/tool-events/explainability/edges are
 * in spec-coverage-state-tools-explainability.test.ts. Deeper unit tests live in the other suites.
 */

import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { buildPostCallDecision } from "../src/decision";
import {
  AmdStatus,
  CallStatus,
  CallWindowDay,
  NormalizedOutcome,
  ScheduledActionType,
} from "../src/decision/types";
import type { ScheduledAction } from "../src/decision/types";
import { makeInput, NOW, PARIS, successPaymentLink } from "./helpers";

const outcomeOf = (overrides: Parameters<typeof makeInput>[0]) =>
  buildPostCallDecision(makeInput(overrides)).normalizedOutcome;
const inParis = (iso: string) => DateTime.fromISO(iso, { zone: PARIS });
const findCall = (actions: ScheduledAction[]) =>
  actions.find((action) => action.type === ScheduledActionType.Call)!;

describe("Spec §1 — Telephony Safety Overrides", () => {
  it("amdStatus machine/voicemail → voice_mail", () => {
    expect(outcomeOf({ call: { amdStatus: AmdStatus.MachineStart } })).toBe(
      NormalizedOutcome.VoiceMail,
    );
    expect(outcomeOf({ call: { amdStatus: AmdStatus.MachineEnd } })).toBe(
      NormalizedOutcome.VoiceMail,
    );
  });

  it("status no-answer / busy / failed → no_answer", () => {
    for (const status of [
      CallStatus.NoAnswer,
      CallStatus.Busy,
      CallStatus.Failed,
    ]) {
      expect(
        outcomeOf({ call: { status, amdStatus: AmdStatus.Unknown } }),
      ).toBe(NormalizedOutcome.NoAnswer);
    }
  });

  it("duration < 7s and no stronger human outcome → early_termination", () => {
    expect(
      outcomeOf({ call: { durationSec: 6 }, insights: { outcome: "" } }),
    ).toBe(NormalizedOutcome.EarlyTermination);
  });

  it("duration < 7s BUT a stronger human outcome → that outcome wins (not early_termination)", () => {
    expect(
      outcomeOf({
        call: { durationSec: 6 },
        insights: { outcome: "Accepted full payment later" },
      }),
    ).toBe(NormalizedOutcome.PromiseToPay);
  });
});

describe("Spec §2 — Outcome Mapping", () => {
  it("'Call rescheduled' OR a valid callbackAt → callback_scheduled", () => {
    expect(outcomeOf({ insights: { outcome: "Call rescheduled" } })).toBe(
      NormalizedOutcome.CallbackScheduled,
    );
    expect(
      outcomeOf({
        insights: { outcome: "", callbackAt: "2025-07-15T10:00:00+02:00" },
      }),
    ).toBe(NormalizedOutcome.CallbackScheduled);
  });

  it("'Accepted full payment later' / 'Accepted payment plan later' → promise_to_pay", () => {
    expect(
      outcomeOf({ insights: { outcome: "Accepted full payment later" } }),
    ).toBe(NormalizedOutcome.PromiseToPay);
    expect(
      outcomeOf({ insights: { outcome: "Accepted payment plan later" } }),
    ).toBe(NormalizedOutcome.PromiseToPay);
  });

  it("'Accepted full payment now' OR a successful payment-link → wait_payment_confirmation", () => {
    expect(
      outcomeOf({ insights: { outcome: "Accepted full payment now" } }),
    ).toBe(NormalizedOutcome.WaitPaymentConfirmation);
    expect(
      outcomeOf({
        toolEvents: [successPaymentLink("2025-07-10T07:00:00+02:00")],
      }),
    ).toBe(NormalizedOutcome.WaitPaymentConfirmation);
  });

  it("'Debt dispute' → disputed, 'Incorrect contact information' → wrong_contact", () => {
    expect(outcomeOf({ insights: { outcome: "Debt dispute" } })).toBe(
      NormalizedOutcome.Disputed,
    );
    expect(
      outcomeOf({ insights: { outcome: "Incorrect contact information" } }),
    ).toBe(NormalizedOutcome.WrongContact);
  });

  it("'Stop contact' → do_not_call, 'Debt payment refusal' → uncooperative", () => {
    expect(outcomeOf({ insights: { outcome: "Stop contact" } })).toBe(
      NormalizedOutcome.DoNotCall,
    );
    expect(outcomeOf({ insights: { outcome: "Debt payment refusal" } })).toBe(
      NormalizedOutcome.Uncooperative,
    );
  });
});

describe("Spec §3 — Scheduling", () => {
  it("never schedules in the past (a past callbackAt is moved forward)", () => {
    const decision = buildPostCallDecision(
      makeInput({
        insights: {
          outcome: "Call rescheduled",
          callbackAt: "2020-01-01T10:00:00+01:00",
        },
      }),
    );
    expect(
      inParis(findCall(decision.scheduledActions).runAt) > inParis(NOW),
    ).toBe(true);
  });

  it("respects the step call window when scheduling a callback", () => {
    const decision = buildPostCallDecision(
      makeInput({
        insights: {
          outcome: "Call rescheduled",
          callbackAt: "2025-07-10T08:30:00+02:00",
        }, // Thu, before window
        step: {
          callWindow: {
            days: [CallWindowDay.Thu],
            start: "10:00",
            end: "12:00",
          },
        },
      }),
    );
    expect(inParis(findCall(decision.scheduledActions).runAt).hour).toBe(10);
  });

  it("avoids weekends unless callWindow.days allows them", () => {
    const decision = buildPostCallDecision(
      makeInput({
        insights: {
          outcome: "Call rescheduled",
          callbackAt: "2025-07-12T09:00:00+02:00",
        },
      }),
    );
    expect(
      inParis(findCall(decision.scheduledActions).runAt).weekday,
    ).toBeLessThanOrEqual(5); // Sat → next weekday
  });

  it("payment date → a payment_reminder at 09:00 Paris on that date", () => {
    const decision = buildPostCallDecision(
      makeInput({
        insights: {
          outcome: "Accepted full payment later",
          paymentDate: "2025-07-20",
        },
      }),
    );
    const reminder = decision.scheduledActions.find(
      (action) => action.type === ScheduledActionType.PaymentReminder,
    )!;
    expect(inParis(reminder.runAt).hour).toBe(9);
    expect(inParis(reminder.runAt).toISODate()).toBe("2025-07-20");
  });

  it("a callback outside the window is adjusted AND a warning is added", () => {
    const decision = buildPostCallDecision(
      makeInput({
        insights: {
          outcome: "Call rescheduled",
          callbackAt: "2025-07-10T08:30:00+02:00",
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
    expect(
      decision.warnings.some((message) => message.includes("adjusted")),
    ).toBe(true);
  });
});
