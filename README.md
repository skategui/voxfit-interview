# Voxfit — Post-Call Decision Engine

A **deterministic, pure** decision engine for an AI voice collections agent. After each call it turns
imperfect, sometimes contradictory signals (telephony metadata, LLM insights, tool events, case
context) into a normalized decision: what to do with the case next.

```ts
buildPostCallDecision(input: PostCallInput): PostCallDecision
```

> **Thesis:** I'd rather ship a robust system with a human fallback than a 100%-automated one that is
> confidently wrong with someone's money. When signals conflict or confidence is low, the engine routes
> to a **manual-review queue** instead of guessing. Automation rate is a tunable, not the goal.

---

## Run it

```bash
npm install
npm test          # 134 tests (vitest)
npm run typecheck # tsc --noEmit, strict
npm run demo      # pipes realistic calls through the engine, prints the auditLog
```

`npm run demo` is the fastest way to *see* the engine think — it prints the `auditLog` for a conflict
call, the "3am" money-safety case, a promise-to-pay, and a no-answer retry, then shows the
event-driven ManualReview store deduping a re-delivered event.

---

## How I used AI to build this

I drove the AI; I did not let it drive me. The process was deliberately staged so I own every decision:

1. **Spec first, in plan mode (no code).** I worked the plan until it matched *my* intent on two axes:
   - **Code architecture** — one concern per file/module, enums for closed vocabularies, file/function
     length limits, an explicit test strategy.
   - **Production reality** — edge cases, an event-driven shape, multi-client configurability, etc.
   Nothing got written until the plan reflected what I wanted and what I could defend.

2. **Execution — Opus 4.8 in "ultracode".** Once the plan was right, the model implemented it.

3. **Independent review — separate sessions, no shared context.** A few sub-agents reviewed the result in
   *fresh* sessions (so no context leaked in): code complexity, does it match the spec, and adversarial
   bug-hunting. This caught **real** defects I then fixed and pinned with tests, rather than trusting the
   first draft:
   - off-hours dialing (no `callWindow` defaulted to 00:00–24:00 → could call a debtor at 03:00);
   - a determinism bug (equal-timestamp tool events reordered the output);
   - a "paid now" case with a *failed* payment link stranded forever (no webhook would ever fire);
   - an unsound `JSON.parse ... as` cast at the store's trust boundary.

4. **Self-challenge.** I then interrogated the build myself: are the edge cases *actually* covered? how are
   null / missing values handled? is every manual-review path real? is money never auto-completed? The
   two-phase classifier and the "3am test" both came out of this scrutiny, not the first generation.

5. **Self-verification.** Finally I ran it myself — `npm test`, `npm run demo` — and read the code line by
   line. Every business rule has a test that encodes *why* it matters (`tests/spec-coverage-*.test.ts` maps
   1:1 to the brief; `tests/manual-review-paths.test.ts` enumerates every human-fallback trigger), so the
   AI's output can't silently regress the intent.

---

## Design in one picture

The decision function is **pure** (no I/O, no `Date.now()`). The **orchestrator** is the event-driven
layer around it. This separation is the core engineering choice: a pure policy core is deterministic and
trivially testable; all side effects live at the edges.

```
CallService            ─emit→ CallCompleted ┐
PaymentService(Stripe) ─emit→ PaymentReceived│  (a separate handler completes the case)
TimerService           ─emit→ PromiseExpired │  (a cron relaunches broken promises)
                                             ▼
                        ┌──────── ORCHESTRATOR (src/services) ──────┐
                        │  buildPostCallDecision(input)  ← pure      │
                        │  → route manual_review actions to the bus  │
                        └───────────────┬────────────────────────────┘
          ┌─────────────────────────────┼─────────────────────────────┐
          ▼                             ▼                             ▼
    CaseStore (apply patch)     Scheduler/JobQueue          ManualReview service
                                (executes call /            (local store, no DB;
                                 payment_reminder)           idempotent, humans resolve)
```

Two responsibilities deliberately live **outside** this function (separation of concerns):

- **Payment confirmation** is owned by a Stripe-webhook handler. *Sending a link ≠ being paid.* The
  engine only moves a case to `wait_payment_confirmation`; the webhook later completes it (idempotent on
  Stripe `event.id`). The silence-timeout for a stuck confirmation is the reconciler's job, not ours.
- **Broken-promise detection** is owned by a timer/cron that fires when a promise date passes unpaid.
  It re-enters the engine; it is not triggered by a call.

### Module map

```
src/decision/         PURE core (deterministic, no I/O)
  types.ts            enums (vocabulary) + interfaces (shapes) — single source of truth
  outcomeMap.ts       LLM-outcome → engine-outcome table + "human-present" set  ← per-client config swap point
  classify.ts         Phase A extractSignals() + Phase B reconcile() (ordered RULES array)
  schedule.ts         Luxon timezone scheduling: never-past, windows, weekends, 09:00 reminders, DST
  guards.ts           pre-classification guards: terminal / settled / stale-event
  transitions.ts      outcome → (casePatch + scheduledActions); one small handler per outcome family
  timeline.ts         reconstructs the event chronology from timestamps → auditLog
  promiseExpiry.ts    SECOND entry point: a broken promise → relaunch (capped) | completed | review
  index.ts            buildPostCallDecision: timeline → classify → guards → transition → assemble
src/services/         STATEFUL edge (event-driven)
  bus.ts              tiny in-process event bus (Node events)
  manualReview.ts     ManualReview consumer + local JSON store; idempotent enqueue/list/resolve
  orchestrator.ts     handleCallCompleted + handlePromiseExpired: decide, route manual_review to store + bus
src/demo.ts           runnable end-to-end showcase
```

**Two entry points, one per event source** — the engine is genuinely event-driven, not call-only:
`handleCallCompleted` (a `CallCompleted` event) and `handlePromiseExpired` (a timer/cron `PromiseExpired`
event). Both are pure-decision + route-reviews; neither executes.

---

## Case state machine

```
                       ┌─────────────── perm_excluded ───────────────┐  (terminal)
                       │            do_not_call / wrong_contact        │
   ┌────────┐  call    │                                              │
   │ active │──────────┤  promise_to_pay ─→ temp_excluded (reminder/follow-up)
   └────────┘          │        │  (PromiseExpired cron) ─→ active (relaunch)
        ▲              │        ▼
        │              │  wait_payment_confirmation ─→ temp_excluded
        │              │        │  (Stripe PaymentReceived) ─→ completed (terminal)
        │              │  callback_scheduled / no_answer / voice_mail /
        │              │  uncooperative ─→ temp_excluded (until nextActionAt)
        │              │  disputed ─→ temp_excluded + manual_review
        └── retry ─────┘        │  (maxAttempts hit) ─→ manual_review
```

- `perm_excluded` / `completed` are **terminal** and absorb late events (idempotent, never resurrected).
- `temp_excluded` = "parked until a known future event": its `nextActionAt` fires, a Stripe webhook
  completes it, or the promise cron relaunches it.

### Payment lifecycle (the money path, across event sources)

The case states above are driven by **three** event sources. The payment sub-lifecycle is what Voxfit
cares about most — drawn explicitly:

```
CALL_DONE
   │ "I'll pay on the 20th"
   ▼
PROMISE_TO_PAY ──schedule reminder──▶ WAITING_PAYMENT
   │                                      │ Stripe PaymentReceived webhook
   │ deadline passes (PromiseExpired cron)│
   ▼                                      ▼
DEADLINE_EXPIRED                       PAYMENT_RECEIVED (completed, terminal)
   │  read LIVE amountRemaining
   ├─ already paid (≤ 0) ─────────────▶ PAYMENT_RECEIVED   (never re-dial a payer)
   ├─ attempts remain ───────────────▶ RELAUNCH ─→ CALL_DONE (loop)
   └─ attempts exhausted ────────────▶ MANUAL_REVIEW        (no infinite relaunch)
```

`promiseExpiry.ts` implements `DEADLINE_EXPIRED`. It reads the **live** `amountRemaining`, so a payment
that arrives *before* the relaunch fires → `completed`, not a re-dial. `WAITING_PAYMENT → PAYMENT_RECEIVED`
is owned by the Stripe-webhook handler (idempotent on `event.id`); the engine never marks money received
on an LLM's say-so.

---

## How a call is classified (two phases, not a flat cascade)

A naive first-match cascade has a real bug: the rule *"short call (<7s) AND no stronger human outcome →
early_termination"* must already know the mapped LLM outcome — but a cascade computes that later, so it
fires blind and can **drop a real payment** (a 5s call where the LLM heard "Accepted full payment now").

So classification is **two phases**:

1. **`extractSignals`** computes three independent signals: `telephony` (`no_contact | voicemail |
   short | ok`), the mapped `insightOutcome`, and the `paymentLinkSent` fact. `short` is a *separate axis*
   from `no_contact` — a 5s call still connected.
2. **`reconcile`** applies an explicit precedence (an ordered, individually-testable `RULES` array) with
   all signals known:

| # | Rule | Result |
|---|------|--------|
| 1 | no human contact **and** a human-present LLM outcome | **`unknown` + manual_review (conflict)** |
| 2 | a successful payment link was sent | `wait_payment_confirmation` (sent ≠ paid) |
| 3 | voicemail (AMD machine) | `voice_mail` |
| 4 | no contact (no-answer/busy/failed) | `no_answer` |
| 5 | short call, no stronger human outcome | `early_termination` |
| 6 | a mapped LLM outcome exists | that outcome |
| 7 | nothing usable | `unknown` + manual_review |

Telephony facts outrank soft LLM signals because the network *knows* whether anyone answered. AMD,
however, is **probabilistic** (false `machine_start` happens) — which is exactly why a voicemail
classification only triggers a cheap, reversible reschedule, never an exclusion.

---

## Event delivery: duplicates, out-of-order, missing (at-least-once)

A collections system runs on an at-least-once bus; **never assume exactly-once or in-order delivery.**

**Who owns each fix** (the "Owner" column) — naming the boundary is the point:

- **Decision engine** — the pure functions in this repo (`src/decision`). ✅ built here.
- **Scheduler** — the downstream worker that executes queued `call` / `payment_reminder` actions. ◻ designed, not built.
- **Sweeper** — a cron that finds calls/cases stuck with no decision. ◻ designed, not built.
- **Stripe reconciler** — a cron that polls Stripe for payments the webhook missed. ◻ designed, not built.

| Scenario | Containment | Owner |
|---|---|---|
| Duplicate `CallCompleted` | engine is deterministic → identical Decision; the Scheduler dedupes by `scheduledAction.id` | Decision engine + Scheduler |
| Payment arrives **before** the call decision | case is already `completed` / `amountRemaining ≤ 0` → short-circuit, no action | Decision engine |
| Payment arrives **after** a retry was queued | a queued action is a snapshot → the Scheduler **re-reads live case state** before dialing; paid → drop the call | Scheduler |
| Out-of-order `CallCompleted` (older than the last) | **watermark guard**: `performedAt ≤ case.lastDecisionAt` → no-op (no backward transition) | Decision engine |
| Out-of-order / duplicate `toolEvents` | sorted by `createdAt` (stable tiebreak), deduped, latest link wins | Decision engine |
| `CallCompleted` never arrives | a Sweeper cron flags calls that produced no decision → manual_review | Sweeper |
| `PaymentReceived` never arrives (lost webhook) | the Stripe reconciler polls Stripe + a `wait_payment_confirmation` silence-timeout | Stripe reconciler |

Two principles make this safe: **(1)** state is monotonic + watermark-guarded (a case never moves
backward; terminal states absorb late events); **(2)** decisions are *snapshots* — the Scheduler
re-validates against live case state before executing, which stops a relaunch firing on a case that got
paid in between (the single most important race here).

The engine implements the parts it can (tool-event dedupe, terminal/settled short-circuit, watermark
guard). The cross-event races are owned by the orchestrator layer; naming that boundary **is** the answer.

---

## Idempotency & determinism

- Pure function → re-running on the same input yields a **deeply-equal** Decision (asserted in tests).
  No `Date.now()` / `Math.random()`; the only clock is `input.now`.
- Tool events are deduped by `id ?? \`${name}|${createdAt}|${status}\`` (the `id` is optional in the spec).
- **Every `scheduledAction` carries a deterministic `id`** (`caseId:callSid:type:reason`), so a downstream
  scheduler collapses duplicate dials/reminders/reviews from a redelivered event — the dial/money path gets
  the same idempotency the ManualReview store has.
- The ManualReview store is idempotent by that same scheme, so a re-delivered `manual_review.requested`
  event collapses to one row.

### Chronology — the "investigator" reflex

The spec says "the transcript is the source of truth", but the payload carries no transcript — only derived
`insights`. So the engine reconstructs the **timeline from timestamps** (`timeline.ts`: call, tool events,
promise date, callback — ordered) and leads every `auditLog` with it. When debriefed *"the payment says A
but the LLM says B"*, the answer is: order events by time, see which is latest, decide or escalate. When a
real `transcript` is provided it's attached to the manual-review payload for the human investigator.

---

## Challenging the spec — gaps & recommendations

The brief is intentionally vague. Things I'd push back on or clarify before production:

- **No raw transcript in the input** — only LLM-derived `insights`. So "the transcript is the source of
  truth" really means *timestamp ordering* of `performedAt` / `toolEvents.createdAt` / `paymentDate`.
  Recommend passing the transcript + a structured event log so the engine can reconstruct chronology.
- **No LLM confidence score** → no way to route ambiguity. Recommend `insights.confidence`; below a
  threshold → manual_review.
- **No payment-amount signal** → partial payments are unrepresentable; `send_payment_link` success means
  *sent*, not *paid*. There is no field in the input that carries "money actually received" — that truth
  lives only in Stripe.
- **`now` vs `performedAt`** relationship is unstated (lag/skew). **`timezone`** is literal-typed yet the
  spec demands DST handling → I read the zone from input rather than hardcoding it.
- Unspecified: the `toolEvents[].name` enum, window precedence (`preferredCallWindow` vs `step.callWindow`),
  outcome multiplicity / tie-break, optional-field defaults, exclusion-reason taxonomy, and any **event
  id / sequence / watermark** to detect duplicate or out-of-order delivery.

### Business cases I'd volunteer (and how the system should treat them)

The brief covers the happy paths. These are the cases it does **not** spell out — the ones that actually
break a collections system in production. `Status` shows what is **built** in this engine vs **designed**
(documented behavior an owning service would implement).

| # | Case (what happens in reality) | How the system should treat it | Status |
|---|---|---|---|
| 1 | **Promise deadline passes, still unpaid** | Timer relaunches the case, **capped** by `maxAttempts` so it can't loop forever; cap reached → review | **Built** — `promiseExpiry.ts` |
| 2 | **Payment lands *before* the relaunch fires** | Read the **live** `amountRemaining`; if paid → `completed`, never re-dial a payer | **Built** — `promiseExpiry.ts` |
| 3 | **Payment lands *after* a relaunch was scheduled** | The Stripe webhook wins; the scheduler re-checks live case state before dialing and drops the call | Designed (executor) |
| 4 | **Partial payment** (paid €40 of €100) | Can't auto-complete or relaunch the full amount → review | Designed |
| 5 | **Double payment** (paid twice) | Never silently keep → review + refund flag | Designed |
| 6 | **Lost or duplicate Stripe webhook** | Reconciler polls Stripe; webhook handler is idempotent on `event.id` | Designed (out-of-scope dependency) |
| 7 | **Low-confidence / ambiguous LLM output** | Route to review (the spec has no confidence field — recommend adding one) | Designed |
| 8 | **One call fits several categories** | Deterministic precedence picks exactly one; a hard-vs-soft contradiction → review | **Built** — `classify.ts` |
| 9 | **Infinite relaunch loop** | `maxAttempts` cap → review | **Built** |
| 10 | **Debtor pays, then disputes** | `disputed` outranks a prior `wait_payment_confirmation` → review (legal/chargeback) | Designed (cross-event) |
| 11 | **`do_not_call` while a payment plan is active** | Compliance wins: `perm_excluded`, cancel reminders, flag the outstanding balance for a human | **Built** — `guards.ts` + `transitions.ts` |

Recurring reflex across all of them: **when money or intent is ambiguous, a human decides.**

---

## Assumptions & tradeoffs

| Assumption | Tradeoff | Why acceptable |
|---|---|---|
| Telephony hard-facts > LLM soft-signals | over-routes to review on conflict | humans are cheap vs a wrong money move |
| Link sent ≠ paid; always `wait_payment_confirmation` | an extra state hop | prevents false "completed" |
| The function decides, never executes | needs a downstream executor | pure, deterministic, testable |
| Payment confirmation owned by Stripe webhook | logic split across services | a call can't observe money |
| Broken-promise owned by a timer cron | another entry point | this fn is one event, not the loop |
| Window = preference ∩ step; **no callWindow → 08:00–20:00 default** (never all-day) | may delay contact | a debt agent must not dial at unsociable hours, even when a step forgets to configure a window |
| Unknown tool names ignored + logged | may miss a new tool | fail-safe, no crash |
| Missing optionals → documented defaults | hidden behavior | defaults are audited |
| `now` is the authoritative clock | caller must pass a correct `now` | determinism |
| One outcome per call (two-phase precedence) | loses multi-label nuance | explainable, reproducible |
| Disputes / double / partial → human queue | lower automation rate | blast-radius control on money |
| Single-tenant nomenclature, table-isolated | not yet generic | YAGNI in the timebox; pivot path documented |
| At-least-once, possibly out-of-order delivery | extra guards/snapshots | safe under retries / dupes / reordering |

---

## Known limitations / unfinished

No real Stripe/Twilio/DB (pure function only) · no persistence/idempotency store beyond function-level
purity + the local ManualReview file · partial payments go to review · no confidence-threshold routing
(field absent) · only Europe/Paris exercised, multi-tz untested · DST verified at known 2025 boundaries
only · no lost-webhook reconciliation (assumed external cron) · free-text exclusion reasons (no enum
taxonomy) · per-client outcome config not built (single map, but isolated for an easy swap) · no aging/SLA
for a stuck `wait_payment_confirmation` beyond the reconciler's timeout.
