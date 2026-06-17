# Voxfit Take-Home Test: Post-Call Decision Engine

## Context

Voxfit builds AI voice agents for operational workflows such as payment collection, customer follow-up, callbacks, payment links, and call analytics.

After each AI call, our system receives several imperfect signals:

- telephony metadata, such as call status, duration, and voicemail detection;
- transcript-derived AI insights, such as whether the caller promised to pay or requested a callback;
- tool events, such as a payment link being sent or a callback being scheduled;
- case context, such as current status, remaining amount, and preferred call window.

Your task is to implement a small deterministic decision engine that decides what should happen to a case after a call.

This is intentionally close to real engineering work: some inputs may conflict, some dates may be invalid, and the system must be safe, explainable, and testable.

## Timebox

Maximum: **2 hours**.

AI tools, documentation, and internet are allowed.

Do not spend time integrating real Twilio, Stripe, OpenAI, or database services. This should run locally.

## Task

Implement a TypeScript module, function, or small service:

```ts
buildPostCallDecision(input: PostCallInput): PostCallDecision
```

You may structure the code however you want, but the output should be deterministic and easy to test.

## Suggested Input Shape

You can adapt the exact types, but your implementation should support this information:

```ts
type PostCallInput = {
  now: string; // ISO timestamp
  timezone: "Europe/Paris";

  call: {
    callSid: string;
    status?: string; // completed, no-answer, busy, failed
    amdStatus?: string | null; // human, machine_start, machine_end, unknown
    durationSec?: number | null;
    performedAt: string;
  };

  case: {
    caseId: string;
    status: "active" | "temp_excluded" | "perm_excluded" | "completed";
    amountRemaining: number;
    currency: string;
    preferredCallWindow?: "8-10" | "10-12" | "12-14" | "14-16" | "16-18" | "18-20" | "any";
  };

  step: {
    stepActionId: string;
    maxAttempts?: number;
    attemptsSoFar?: number;
    retryDelayHours?: number;
    callWindow?: {
      days: Array<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun">;
      start: string; // HH:mm
      end: string;   // HH:mm
    };
    promiseFollowupDelayDays?: number;
  };

  insights: {
    summary?: string;
    outcome?: string; // e.g. No Answer, Call rescheduled, Accepted full payment later, Stop contact
    paymentDate?: string | null;
    callbackAt?: string | null;
  };

  toolEvents?: Array<{
    id?: string;
    name: string;
    status: "success" | "failed";
    createdAt: string;
    result?: Record<string, unknown>;
  }>;
};
```

## Suggested Output Shape

Return a normalized decision:

```ts
type PostCallDecision = {
  normalizedOutcome:
    | "no_answer"
    | "voice_mail"
    | "early_termination"
    | "callback_scheduled"
    | "promise_to_pay"
    | "wait_payment_confirmation"
    | "disputed"
    | "wrong_contact"
    | "do_not_call"
    | "uncooperative"
    | "unknown";

  casePatch: {
    status?: "active" | "temp_excluded" | "perm_excluded" | "completed";
    temporaryExclusionReason?: string | null;
    permanentExclusionReason?: string | null;
    nextActionAt?: string | null;
    paymentPromiseDate?: string | null;
  };

  scheduledActions: Array<{
    type: "call" | "payment_reminder" | "manual_review";
    runAt: string;
    reason: string;
  }>;

  callPatch: {
    outcome: string;
    summary?: string;
    paymentLinkSent?: boolean;
  };

  warnings: string[];
  auditLog: string[];
};
```

## Business Rules

Implement the rules you think are most important. At minimum:

### 1. Telephony Safety Overrides

- If `amdStatus` indicates machine or voicemail, classify as `voice_mail`.
- If `status` is `no-answer`, `busy`, or `failed`, classify as `no_answer`.
- If duration is below 7 seconds and there is no stronger human outcome, classify as `early_termination`.

### 2. Outcome Mapping

- `Call rescheduled` or a valid `callbackAt` means `callback_scheduled`.
- `Accepted full payment later` or `Accepted payment plan later` means `promise_to_pay`.
- `Accepted full payment now` or a successful payment-link tool event means `wait_payment_confirmation`.
- `Debt dispute` means `disputed`.
- `Incorrect contact information` means `wrong_contact`.
- `Stop contact` means `do_not_call`.
- `Debt payment refusal` means `uncooperative`.

### 3. Scheduling

- Use `Europe/Paris` for local scheduling.
- Never schedule in the past.
- Respect the step call window when scheduling callbacks.
- Avoid weekends unless the provided `callWindow.days` allows them.
- If a payment date exists, schedule a `payment_reminder` at 09:00 Paris time on that date.
- If a callback date is invalid or outside the call window, make a reasonable adjustment and add a warning.

### 4. Case State

- `do_not_call` and `wrong_contact` should permanently exclude the case.
- `callback_scheduled`, `promise_to_pay`, `wait_payment_confirmation`, `disputed`, `uncooperative`, `no_answer`, and `voice_mail` should temporarily exclude the case when a future action is needed.
- If max attempts have been reached after no-answer outcomes, do not schedule another call; add a warning or manual-review action.

### 5. Tool Events

- A successful `send_payment_link` or `send_payment_plan_link` should set `paymentLinkSent: true`.
- Failed tool events should not trigger state changes, but should appear in warnings or audit logs.
- Duplicate tool events should not create duplicate scheduled actions.

### 6. Explainability

- The output must include enough `auditLog` entries to understand why the decision was made.

## Edge Cases To Consider

You do not need to solve everything perfectly, but your README should explain your choices.

Consider:

- conflicting signals, such as transcript says payment accepted but call status is no-answer;
- invalid dates;
- past callback/payment dates;
- already permanently excluded cases;
- duplicate tool events;
- missing optional fields;
- boundary times near the end of a call window;
- daylight saving and timezone handling.

## Deliverables

Submit:

- final code;
- tests covering the main rules and at least 4 edge cases;
- a short README explaining how to run it;
- assumptions and tradeoffs;
- known limitations or unfinished parts;
- a short note describing how you used AI tools, including what you validated manually.

## What We Evaluate

We evaluate:

- problem decomposition;
- code quality and maintainability;
- correctness of core business rules;
- edge-case handling;
- deterministic behavior;
- test quality;
- simplicity of the solution;
- product and engineering judgment;
- clarity of written explanation;
- ability to use AI tools effectively without blindly trusting them.

There is no single perfect implementation. We care about whether your solution is clear, robust, explainable, and appropriately scoped for the timebox.
