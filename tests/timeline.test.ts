/**
 * Event-timeline / chronology tests — the "investigator" reflex.
 * The engine reconstructs the order of events from timestamps (no transcript in
 * the payload) and surfaces it in the auditLog; the raw transcript, when given,
 * rides along to the human reviewer.
 */

import { describe, expect, it } from "vitest";
import { buildPostCallDecision } from "../src/decision";
import { buildTimeline, summarizeTimeline } from "../src/decision/timeline";
import { CallStatus } from "../src/decision/types";
import { handleCallCompleted } from "../src/services/orchestrator";
import { ManualReviewStore } from "../src/services/manualReview";
import { makeInput, successPaymentLink } from "./helpers";

describe("buildTimeline", () => {
  it("orders the call and tool events chronologically", () => {
    const input = makeInput({
      call: { performedAt: "2025-07-10T07:55:00+02:00" },
      toolEvents: [successPaymentLink("2025-07-10T07:58:00+02:00")],
      insights: { outcome: "Accepted full payment now" },
    });
    const timeline = buildTimeline(input);
    expect(timeline[0]?.kind).toBe("call");
    expect(timeline[1]?.kind).toBe("tool:send_payment_link:success");
  });

  it("includes the promise date and callback as timeline events", () => {
    const input = makeInput({
      insights: {
        outcome: "Accepted full payment later",
        paymentDate: "2025-07-20",
        callbackAt: "2025-07-21T10:00:00+02:00",
      },
    });
    const kinds = buildTimeline(input).map((event) => event.kind);
    expect(kinds).toContain("promise_date");
    expect(kinds).toContain("callback");
  });

  it("summarizeTimeline renders a one-line chronology", () => {
    const input = makeInput({
      call: { performedAt: "2025-07-10T07:55:00+02:00" },
    });
    expect(summarizeTimeline(buildTimeline(input))).toMatch(
      /^timeline: .*=call/,
    );
  });
});

describe("decision audit includes the reconstructed timeline", () => {
  it("the auditLog leads with the chronology", () => {
    const decision = buildPostCallDecision(
      makeInput({
        call: { status: CallStatus.NoAnswer },
        insights: { outcome: "No Answer" },
      }),
    );
    expect(decision.auditLog[0]).toMatch(/^timeline:/);
  });
});

describe("transcript reaches the human reviewer", () => {
  it("a review item carries the transcript when one is provided", () => {
    const store = new ManualReviewStore(null);
    const input = makeInput({
      insights: {
        outcome: "Debt dispute",
        transcript: "AGENT: ... DEBTOR: I dispute this debt.",
      },
    });
    const { enqueued } = handleCallCompleted(input, store);
    expect(enqueued[0]?.transcript).toContain("I dispute this debt");
  });

  it("no transcript field when none is provided", () => {
    const store = new ManualReviewStore(null);
    const { enqueued } = handleCallCompleted(
      makeInput({ insights: { outcome: "Debt dispute" } }),
      store,
    );
    expect(enqueued[0]?.transcript).toBeUndefined();
  });
});
