# CLAUDE.md

Guidance for working in this repo. Read before changing code.

## What this is

A **deterministic, pure** post-call decision engine for an AI voice **collections** agent. After each
call (or a promise-deadline timer), it decides what happens to a debt case next. The brief is the Voxfit
take-home; the design philosophy: **when signals conflict or money is unconfirmed, route to a human
review queue — never guess.**

## Commands

```bash
npm install
npm test          # vitest — full suite (must stay green)
npm run typecheck # tsc --noEmit, strict
npm run demo      # runs both entry points end-to-end, prints the auditLog
```

There is no build step (library + tests). Tests are the source of truth — run them after every change.

## Architecture (where things live)

```
src/decision/   PURE core — no I/O, no Date.now(); the only clock is input.now
  types.ts        enums (closed vocabularies) + interfaces (shapes). SINGLE SOURCE OF TRUTH.
  outcomeMap.ts   LLM-outcome text → engine outcome + "human-present" set  ← per-client config swap point
  classify.ts     extractSignals() then reconcile() — two-phase, ordered RULES array
  schedule.ts     Luxon timezone scheduling (never-past, call windows, weekends, 09:00 reminders, DST)
  guards.ts       pre-classification short-circuits: terminal / settled / stale-event
  transitions.ts  outcome → (casePatch + scheduledActions); one small handler per outcome family
  timeline.ts     reconstructs event chronology from timestamps → auditLog
  promiseExpiry.ts SECOND entry point: a broken promise → relaunch (capped) | completed | review
  index.ts        buildPostCallDecision: timeline → classify → guards → transition → assemble
src/services/   STATEFUL edge — event-driven, the only place with I/O
  bus.ts          tiny in-process EventEmitter
  manualReview.ts ManualReview consumer + local JSON store (no DB); idempotent enqueue/list/resolve
  orchestrator.ts handleCallCompleted + handlePromiseExpired; route manual_review actions to store + bus
tests/          one file per concern, named for what it tests
```

**The boundary is the point:** the decision functions are pure and only *describe* a patch + actions;
services execute. Don't move I/O into `src/decision/`. Don't move policy into `src/services/`.

## Non-negotiable design decisions (don't "simplify" these away)

- **Money is never auto-completed on an LLM's say-so.** "Accepted full payment now" → `wait_payment_confirmation`,
  completed only by a Stripe webhook. See the "3am test" in `tests/edge-cases.test.ts`.
- **Two-phase classification, not a flat cascade.** A cascade drops a real payment on a short "paid" call
  (rule 5 needs the mapped outcome rule 6 computes). Keep extract → reconcile. See `B1 ORDERING BUG GUARD`.
- **Deterministic + idempotent.** Same input → deeply-equal output. No `Date.now()`/`Math.random()`. Tool
  events deduped by stable key; every `scheduledAction` has a deterministic `id`; ManualReview dedupes by id.
- **Ambiguity → `manual_review`.** Conflicting signals, unknown outcome, disputes, "paid" with no successful
  link, max attempts → a human. Every path is enumerated in `tests/manual-review-paths.test.ts`.
- **Two entry points** (`handleCallCompleted`, `handlePromiseExpired`) — the engine is event-driven, not call-only.

## Conventions

- **TypeScript, strict.** **Enums** for every closed vocabulary, **interfaces** for object shapes — both in `types.ts`.
- **Constants at the top** of each file. **≤ 300 lines per file, ≤ 50 lines per function** (hard limits — split if exceeded).
- **Explicit names.** No `a`/`b`/`d`/`s`/`tmp`. Variables say what they hold.
- **Luxon** for all date/time; never hand-roll timezone or DST math. Read the zone from `input.timezone`.
- **Comments explain WHY** (business rule, money safety), not what the code already says.
- A formatter runs on save — don't fight it; match the surrounding style.

## When you change behavior

- Add/adjust a test that encodes **why** it matters (not just what). Money/edge paths must have a regression test.
- Spec rules map 1:1 in `tests/spec-coverage-*.test.ts` — keep that mapping intact.
- Run `npm test` + `npm run typecheck`; both must pass before "done".
- `input.now` is the clock. If you need "now", thread it through — never call `Date.now()`.

## Known scope boundaries (by design, documented in README)

No real Stripe/Twilio/DB. Payment confirmation = a Stripe-webhook handler (idempotent on `event.id`),
not this engine. Lost-webhook reconciliation, partial payments, confidence-threshold routing, and
per-client outcome config are documented recommendations, not built. Don't stub fakes for them — route to
review and note it.
