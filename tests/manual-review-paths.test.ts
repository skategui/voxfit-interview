/**
 * EVERY path to manual_review — exhaustive coverage of "when does a human get
 * pulled in?". For each trigger we assert (a) the decision emits a manual_review
 * action with the expected reason tag, and (b) the orchestrator routes it into the
 * ManualReview store. This is the human-fallback safety net, so it is enumerated.
 */

import { describe, expect, it } from "vitest";
import { buildPostCallDecision } from "../src/decision";
import { ScheduledActionType } from "../src/decision/types";
import { handleCallCompleted } from "../src/services/orchestrator";
import { ManualReviewStore } from "../src/services/manualReview";
import { AmdStatus, CallStatus } from "../src/decision/types";
import type { InputOverrides } from "./helpers";
import { makeInput } from "./helpers";

interface ReviewScenario {
  name: string;
  overrides: InputOverrides;
  expectedReason: string;
}

const REVIEW_SCENARIOS: ReviewScenario[] = [
  {
    name: "conflict (no contact, but LLM reports a human outcome)",
    overrides: {
      call: { status: CallStatus.NoAnswer, amdStatus: AmdStatus.Unknown },
      insights: { outcome: "Accepted full payment now" },
    },
    expectedReason: "conflict",
  },
  {
    name: "unknown / unmappable LLM outcome",
    overrides: { insights: { outcome: "a label nobody has mapped yet" } },
    expectedReason: "unknown_outcome",
  },
  {
    name: "debt dispute (legal / chargeback)",
    overrides: { insights: { outcome: "Debt dispute" } },
    expectedReason: "disputed",
  },
  {
    name: "payment refusal (uncooperative)",
    overrides: { insights: { outcome: "Debt payment refusal" } },
    expectedReason: "uncooperative",
  },
  {
    name: "do_not_call with an outstanding balance (compliance + write-off)",
    overrides: { insights: { outcome: "Stop contact" } }, // amountRemaining defaults to 100 > 0
    expectedReason: "do_not_call",
  },
  {
    name: "wrong contact (a human must find the right number)",
    overrides: { insights: { outcome: "Incorrect contact information" } },
    expectedReason: "wrong_contact",
  },
  {
    name: "no_answer at the attempt cap",
    overrides: {
      call: { status: CallStatus.NoAnswer, amdStatus: AmdStatus.Unknown },
      insights: { outcome: "No Answer" },
      step: { attemptsSoFar: 5, maxAttempts: 5 },
    },
    expectedReason: "no_answer_max_attempts",
  },
  {
    name: "voice_mail at the attempt cap",
    overrides: {
      call: { amdStatus: AmdStatus.MachineStart },
      insights: { outcome: "" },
      step: { attemptsSoFar: 5, maxAttempts: 5 },
    },
    expectedReason: "voice_mail_max_attempts",
  },
  {
    name: "early_termination at the attempt cap",
    overrides: {
      call: { durationSec: 3 },
      insights: { outcome: "" },
      step: { attemptsSoFar: 5, maxAttempts: 5 },
    },
    expectedReason: "early_termination_max_attempts",
  },
  {
    name: "invalid `now` (cannot schedule safely)",
    overrides: { now: "not-a-timestamp" },
    expectedReason: "invalid_now",
  },
];

describe("paths to manual_review — the decision emits the right reason", () => {
  for (const scenario of REVIEW_SCENARIOS) {
    it(scenario.name, () => {
      const decision = buildPostCallDecision(makeInput(scenario.overrides));
      const reviewActions = decision.scheduledActions.filter(
        (action) => action.type === ScheduledActionType.ManualReview,
      );
      expect(reviewActions).toHaveLength(1);
      expect(reviewActions[0]?.reason).toBe(scenario.expectedReason);
    });
  }
});

describe("paths to manual_review — the orchestrator routes each into the store", () => {
  for (const scenario of REVIEW_SCENARIOS) {
    it(scenario.name, () => {
      const store = new ManualReviewStore(null);
      const { enqueued } = handleCallCompleted(
        makeInput(scenario.overrides),
        store,
      );
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]?.reason).toBe(scenario.expectedReason);
      expect(store.size()).toBe(1);
    });
  }
});

describe("non-review outcomes do NOT pull in a human", () => {
  it("a plain callback schedules a call, not a review", () => {
    const decision = buildPostCallDecision(
      makeInput({
        insights: {
          outcome: "Call rescheduled",
          callbackAt: "2025-07-15T10:00:00+02:00",
        },
      }),
    );
    expect(
      decision.scheduledActions.some(
        (action) => action.type === ScheduledActionType.ManualReview,
      ),
    ).toBe(false);
  });

  it("a no-answer with attempts remaining retries, not a review", () => {
    const decision = buildPostCallDecision(
      makeInput({
        call: { status: CallStatus.NoAnswer, amdStatus: AmdStatus.Unknown },
        insights: { outcome: "No Answer" },
        step: { attemptsSoFar: 0, maxAttempts: 5 },
      }),
    );
    expect(
      decision.scheduledActions.some(
        (action) => action.type === ScheduledActionType.ManualReview,
      ),
    ).toBe(false);
  });
});
