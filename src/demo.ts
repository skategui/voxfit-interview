/**
 * Runnable demo: pipes a few realistic calls through the engine and prints the
 * decisions + the ManualReview store. Run with: `npm run demo`.
 *
 * This is the real codepath end-to-end (decision → orchestrator → local store),
 * not a mock — it's how a reviewer can see the engine "think" via the auditLog.
 */

import { buildPostCallDecision, buildPromiseExpiryDecision } from "./decision";
import {
  AmdStatus,
  CallStatus,
  CaseStatus,
  ToolEventStatus,
} from "./decision/types";
import type { PostCallInput } from "./decision/types";
import { handleCallCompleted } from "./services/orchestrator";
import { ManualReviewStore } from "./services/manualReview";

const NOW = "2025-07-10T08:00:00+02:00"; // Thursday, Paris (CEST)

const base = (over: Partial<PostCallInput> = {}): PostCallInput => ({
  now: NOW,
  timezone: "Europe/Paris",
  call: {
    callSid: "CA_demo",
    status: CallStatus.Completed,
    amdStatus: AmdStatus.Human,
    durationSec: 60,
    performedAt: NOW,
  },
  case: {
    caseId: "CASE_demo",
    status: CaseStatus.Active,
    amountRemaining: 250,
    currency: "EUR",
  },
  step: {
    stepActionId: "STEP_demo",
    maxAttempts: 3,
    attemptsSoFar: 0,
    retryDelayHours: 24,
  },
  insights: {},
  ...over,
});

const scenarios: Array<{ title: string; input: PostCallInput }> = [
  {
    title: "Conflict — no answer but LLM says 'paid' (→ manual review)",
    input: base({
      call: {
        callSid: "CA_1",
        status: CallStatus.NoAnswer,
        amdStatus: AmdStatus.Unknown,
        performedAt: NOW,
      },
      insights: {
        outcome: "Accepted full payment now",
        summary: "claims paid",
      },
    }),
  },
  {
    title: "3am test — link sent + 'paid now' (→ wait, NOT completed)",
    input: base({
      insights: { outcome: "Accepted full payment now" },
      toolEvents: [
        {
          id: "te_1",
          name: "send_payment_link",
          status: ToolEventStatus.Success,
          createdAt: NOW,
        },
      ],
    }),
  },
  {
    title: "Promise to pay with a date (→ 09:00 reminder)",
    input: base({
      insights: {
        outcome: "Accepted full payment later",
        paymentDate: "2025-07-20",
      },
    }),
  },
  {
    title: "No answer, attempts remaining (→ retry call)",
    input: base({
      call: {
        callSid: "CA_2",
        status: CallStatus.NoAnswer,
        amdStatus: AmdStatus.Unknown,
        performedAt: NOW,
      },
      insights: { outcome: "No Answer" },
    }),
  },
];

for (const { title, input } of scenarios) {
  const decision = buildPostCallDecision(input);
  console.log(`\n=== ${title} ===`);
  console.log(`outcome: ${decision.normalizedOutcome}`);
  console.log(`casePatch: ${JSON.stringify(decision.casePatch)}`);
  console.log(`actions: ${JSON.stringify(decision.scheduledActions)}`);
  if (decision.warnings.length)
    console.log(`warnings: ${JSON.stringify(decision.warnings)}`);
  console.log(`audit:\n  - ${decision.auditLog.join("\n  - ")}`);
}

// Second entry point: a broken payment promise (timer event).
console.log("\n=== PromiseExpired — broken promise lifecycle ===");
const promiseBase = {
  now: NOW,
  timezone: "Europe/Paris",
  step: { stepActionId: "STEP_demo", attemptsSoFar: 1, maxAttempts: 3 },
  promiseId: "CA_promise",
  promiseDate: "2025-07-09",
};
const paid = buildPromiseExpiryDecision({
  ...promiseBase,
  case: {
    caseId: "C1",
    status: CaseStatus.TempExcluded,
    amountRemaining: 0,
    currency: "EUR",
  },
});
console.log(
  `paid before relaunch  → status=${paid.casePatch.status}, actions=${paid.scheduledActions.length}  (never re-dial a payer)`,
);
const broken = buildPromiseExpiryDecision({
  ...promiseBase,
  case: {
    caseId: "C2",
    status: CaseStatus.TempExcluded,
    amountRemaining: 250,
    currency: "EUR",
  },
});
console.log(
  `still owed → ${broken.scheduledActions[0]?.reason} @ ${broken.scheduledActions[0]?.runAt}`,
);

// Event-driven loop: route manual_review actions into the local store (idempotent).
console.log("\n=== ManualReview store (event-driven, idempotent) ===");
const store = new ManualReviewStore(null); // in-memory for the demo
const conflict = scenarios[0]!.input;
handleCallCompleted(conflict, store);
handleCallCompleted(conflict, store); // re-deliver same event → no duplicate
console.log(`rows after delivering the same event twice: ${store.size()}`);
console.log(JSON.stringify(store.list(), null, 2));
