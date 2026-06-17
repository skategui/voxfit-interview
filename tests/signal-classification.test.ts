/**
 * Classification tests — the two-phase extract→reconcile core.
 * Covers every precedence rule, the conflict detector, the B1 ordering bug a flat
 * cascade would have, and tool-event dedupe / out-of-order handling.
 */

import { describe, expect, it } from "vitest";
import { classify, extractSignals, reconcile } from "../src/decision/classify";
import {
  AmdStatus,
  CallStatus,
  NormalizedOutcome,
  ReviewReason,
  TelephonyKind,
  ToolEventStatus,
} from "../src/decision/types";
import { makeInput, successPaymentLink } from "./helpers";

describe("extractSignals (Phase A)", () => {
  it("classifies voicemail from amdStatus (probabilistic AMD)", () => {
    const signals = extractSignals(
      makeInput({ call: { amdStatus: AmdStatus.MachineStart } }),
    );
    expect(signals.telephony).toBe(TelephonyKind.Voicemail);
  });

  it("classifies no_contact from failed/busy/no-answer status", () => {
    for (const status of [
      CallStatus.NoAnswer,
      CallStatus.Busy,
      CallStatus.Failed,
    ]) {
      const signals = extractSignals(
        makeInput({ call: { status, amdStatus: AmdStatus.Unknown } }),
      );
      expect(signals.telephony).toBe(TelephonyKind.NoContact);
    }
  });

  it("treats a <7s CONNECTED call as `short`, not `no_contact`", () => {
    const signals = extractSignals(
      makeInput({ call: { durationSec: 5, amdStatus: AmdStatus.Human } }),
    );
    expect(signals.telephony).toBe(TelephonyKind.Short);
  });

  it("maps a valid callbackAt to a callback outcome even with vague text", () => {
    const signals = extractSignals(
      makeInput({
        insights: { outcome: "", callbackAt: "2025-07-15T10:00:00+02:00" },
      }),
    );
    expect(signals.insightOutcome).toBe(NormalizedOutcome.CallbackScheduled);
  });

  it("normalizes outcome text (case/whitespace insensitive)", () => {
    const signals = extractSignals(
      makeInput({ insights: { outcome: "  Debt Dispute  " } }),
    );
    expect(signals.insightOutcome).toBe(NormalizedOutcome.Disputed);
  });

  it("does NOT infer a promise from a bare paymentDate (needs an explicit outcome)", () => {
    const signals = extractSignals(
      makeInput({ insights: { outcome: "", paymentDate: "2025-07-20" } }),
    );
    expect(signals.insightOutcome).toBeNull();
  });
});

describe("reconcile (Phase B) — precedence", () => {
  it("Rule 1: no_contact + human-present outcome → conflict → review", () => {
    // Why it matters: if nobody answered, the LLM can't have heard "paid". Don't
    // trust either signal — a human investigates. (money safety)
    const classification = classify(
      makeInput({
        call: { status: CallStatus.NoAnswer, amdStatus: AmdStatus.Unknown },
        insights: { outcome: "Accepted full payment now" },
      }),
    );
    expect(classification.outcome).toBe(NormalizedOutcome.Unknown);
    expect(classification.reviewReason).toBe(ReviewReason.Conflict);
  });

  it("Rule 2: a successful payment link → wait_payment_confirmation (sent ≠ paid)", () => {
    const classification = classify(
      makeInput({
        toolEvents: [successPaymentLink("2025-07-10T07:59:00+02:00")],
      }),
    );
    expect(classification.outcome).toBe(
      NormalizedOutcome.WaitPaymentConfirmation,
    );
    expect(classification.paymentLinkSent).toBe(true);
  });

  it("Rule 2 fires even after a no-answer call (link is a system-side fact)", () => {
    const classification = classify(
      makeInput({
        call: { status: CallStatus.NoAnswer, amdStatus: AmdStatus.Unknown },
        insights: { outcome: "No Answer" },
        toolEvents: [successPaymentLink("2025-07-10T07:59:00+02:00")],
      }),
    );
    expect(classification.outcome).toBe(
      NormalizedOutcome.WaitPaymentConfirmation,
    );
  });

  it("Rule 3/4: voicemail → voice_mail, no-answer → no_answer", () => {
    expect(
      classify(makeInput({ call: { amdStatus: AmdStatus.MachineEnd } }))
        .outcome,
    ).toBe(NormalizedOutcome.VoiceMail);
    expect(
      classify(
        makeInput({
          call: { status: CallStatus.NoAnswer, amdStatus: AmdStatus.Unknown },
        }),
      ).outcome,
    ).toBe(NormalizedOutcome.NoAnswer);
  });

  it("Rule 5: short call with no human outcome → early_termination", () => {
    const classification = classify(
      makeInput({ call: { durationSec: 4 }, insights: { outcome: "" } }),
    );
    expect(classification.outcome).toBe(NormalizedOutcome.EarlyTermination);
  });

  it("B1 ORDERING BUG GUARD: short call + 'Accepted full payment now' is NOT early_termination", () => {
    // A flat cascade would fire rule 5 before mapping the outcome and drop the
    // payment. Two-phase reconcile sees the human outcome and keeps it.
    const classification = classify(
      makeInput({
        call: { durationSec: 5 },
        insights: { outcome: "Accepted full payment now" },
      }),
    );
    expect(classification.outcome).toBe(
      NormalizedOutcome.WaitPaymentConfirmation,
    );
  });

  it("Rule 6: trusts the mapped LLM outcome on a normal call", () => {
    expect(
      classify(makeInput({ insights: { outcome: "Debt payment refusal" } }))
        .outcome,
    ).toBe(NormalizedOutcome.Uncooperative);
  });

  it("Rule 7: unmappable outcome on a connected call → unknown → review", () => {
    const classification = classify(
      makeInput({ insights: { outcome: "some new llm label nobody mapped" } }),
    );
    expect(classification.outcome).toBe(NormalizedOutcome.Unknown);
    expect(classification.reviewReason).toBe(ReviewReason.UnknownOutcome);
  });
});

describe("tool-event dedupe & ordering", () => {
  it("dedupes duplicate events by id → single deduped event", () => {
    const duplicateEvent = successPaymentLink(
      "2025-07-10T07:00:00+02:00",
      "te_dup",
    );
    const signals = extractSignals(
      makeInput({
        toolEvents: [
          duplicateEvent,
          { ...duplicateEvent },
          { ...duplicateEvent },
        ],
      }),
    );
    expect(signals.dedupedToolEvents).toHaveLength(1);
    expect(signals.paymentLinkSent).toBe(true);
  });

  it("out-of-order events: latest successful link wins, result is order-independent", () => {
    const failedEarlierLink = {
      ...successPaymentLink("2025-07-10T06:00:00+02:00", "earlier"),
      status: ToolEventStatus.Failed,
    };
    const successfulLaterLink = successPaymentLink(
      "2025-07-10T07:00:00+02:00",
      "later",
    );
    const signalsForward = extractSignals(
      makeInput({ toolEvents: [failedEarlierLink, successfulLaterLink] }),
    );
    const signalsReversed = extractSignals(
      makeInput({ toolEvents: [successfulLaterLink, failedEarlierLink] }),
    );
    expect(signalsForward.dedupedToolEvents).toEqual(
      signalsReversed.dedupedToolEvents,
    ); // stable order
    expect(signalsForward.paymentLinkSent).toBe(true);
  });

  it("an event with no id still dedupes via composite key", () => {
    const eventWithoutId = {
      name: "send_payment_link",
      status: ToolEventStatus.Success,
      createdAt: "2025-07-10T07:00:00+02:00",
    };
    const signals = extractSignals(
      makeInput({ toolEvents: [eventWithoutId, { ...eventWithoutId }] }),
    );
    expect(signals.dedupedToolEvents).toHaveLength(1);
  });

  it("reconcile always returns a result (fallback rule is total)", () => {
    const signals = extractSignals(
      makeInput({ call: { amdStatus: AmdStatus.Human }, insights: {} }),
    );
    expect(reconcile(signals).outcome).toBeDefined();
  });
});
