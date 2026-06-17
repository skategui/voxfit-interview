/**
 * Signal classification — the core of the engine.
 *
 * Deliberately TWO phases, not a flat first-match cascade:
 *   Phase A — extractSignals(): compute three INDEPENDENT signals (telephony,
 *             mapped LLM outcome, payment-link fact). No ordering between them.
 *   Phase B — reconcile():      apply an explicit precedence (the RULES array)
 *             with ALL signals already known.
 *
 * Why not a flat cascade? The rule "short call (<7s) AND no stronger human
 * outcome → early_termination" needs the mapped LLM outcome. In a cascade that
 * outcome is computed *later*, so the rule fires blind and can drop a real
 * payment (a 5s call where the LLM heard "Accepted full payment now").
 * Extract-then-reconcile removes that forward dependency.
 *
 * The precedence is an ordered array of pure predicates, so each rule is tiny
 * and independently testable, and reconcile() is just "first match wins".
 */

import {
  HUMAN_PRESENT_OUTCOMES,
  OUTCOME_MAP,
  normalizeOutcomeKey,
} from "./outcomeMap";
import { isValidIso } from "./schedule";
import {
  AmdStatus,
  CallStatus,
  NormalizedOutcome,
  ReviewReason,
  TelephonyKind,
  ToolEventStatus,
  ToolName,
} from "./types";
import type { CallInfo, Insights, PostCallInput, ToolEvent } from "./types";

// --- Constants --------------------------------------------------------------
const SHORT_CALL_THRESHOLD_SEC = 7;

const PAYMENT_LINK_TOOLS: ReadonlySet<string> = new Set([
  ToolName.SendPaymentLink,
  ToolName.SendPaymentPlanLink,
]);

const NO_CONTACT_KINDS: ReadonlySet<TelephonyKind> = new Set([
  TelephonyKind.NoContact,
  TelephonyKind.Voicemail,
]);

// --- Types ------------------------------------------------------------------
export interface ExtractedSignals {
  telephony: TelephonyKind;
  insightOutcome: NormalizedOutcome | null;
  insightKey: string; // normalized LLM outcome string (for conflict detection)
  paymentLinkSent: boolean;
  dedupedToolEvents: ToolEvent[];
}

export interface Classification {
  outcome: NormalizedOutcome;
  reviewReason: ReviewReason; // tag for a manual_review action / audit
  paymentLinkSent: boolean;
  audit: string[];
}

interface RuleHit {
  outcome: NormalizedOutcome;
  reviewReason: ReviewReason;
  note: string; // audit line explaining why this rule fired
}

type Rule = (signals: ExtractedSignals) => RuleHit | null;

// --- Phase A: extract -------------------------------------------------------

/** Stable dedupe key. `id` is optional, so fall back to a composite that is
 *  still stable across at-least-once redelivery of the same event. */
const toolEventKey = (event: ToolEvent): string =>
  event.id ?? `${event.name}|${event.createdAt}|${event.status}`;

const createdAtMillis = (event: ToolEvent): number => {
  const parsed = Date.parse(event.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** Dedupe tool events, keeping the LATEST per key. Canonical order: createdAt asc,
 *  then dedupe key — INPUT-ORDER-INDEPENDENT, so out-of-order delivery of the same
 *  events yields the same result (determinism, even for equal timestamps). */
const dedupeToolEvents = (events: readonly ToolEvent[]): ToolEvent[] => {
  const sorted = [...events].sort((left, right) => {
    const leftMillis = createdAtMillis(left);
    const rightMillis = createdAtMillis(right);
    if (leftMillis !== rightMillis) return leftMillis - rightMillis;
    return toolEventKey(left).localeCompare(toolEventKey(right)); // stable, not input-order-dependent
  });
  const latestByKey = new Map<string, ToolEvent>();
  for (const event of sorted) latestByKey.set(toolEventKey(event), event); // later (latest createdAt) overwrites
  return [...latestByKey.values()];
};

const extractTelephony = (call: CallInfo): TelephonyKind => {
  const amdStatus = call.amdStatus ?? null;
  if (
    amdStatus === AmdStatus.MachineStart ||
    amdStatus === AmdStatus.MachineEnd
  ) {
    return TelephonyKind.Voicemail;
  }

  const callStatus = call.status;
  if (
    callStatus === CallStatus.NoAnswer ||
    callStatus === CallStatus.Busy ||
    callStatus === CallStatus.Failed
  ) {
    return TelephonyKind.NoContact;
  }

  const durationSeconds = call.durationSec ?? null;
  if (durationSeconds !== null && durationSeconds < SHORT_CALL_THRESHOLD_SEC) {
    return TelephonyKind.Short; // connected, brief
  }
  return TelephonyKind.Ok;
};

/** Map the LLM outcome to the engine vocabulary. A valid callbackAt is itself a
 *  callback signal. A bare paymentDate is NOT a promise (needs an explicit outcome). */
const extractInsightOutcome = (
  insights: Insights,
): { insightOutcome: NormalizedOutcome | null; insightKey: string } => {
  const insightKey = normalizeOutcomeKey(insights.outcome);
  let insightOutcome: NormalizedOutcome | null =
    OUTCOME_MAP[insightKey] ?? null;
  if (!insightOutcome && isValidIso(insights.callbackAt))
    insightOutcome = NormalizedOutcome.CallbackScheduled;
  return { insightOutcome, insightKey };
};

export const extractSignals = (input: PostCallInput): ExtractedSignals => {
  const dedupedToolEvents = dedupeToolEvents(input.toolEvents ?? []);
  const paymentLinkSent = dedupedToolEvents.some(
    (event) =>
      event.status === ToolEventStatus.Success &&
      PAYMENT_LINK_TOOLS.has(event.name),
  );
  const { insightOutcome, insightKey } = extractInsightOutcome(input.insights);
  return {
    telephony: extractTelephony(input.call),
    insightOutcome,
    insightKey,
    paymentLinkSent,
    dedupedToolEvents,
  };
};

// --- Phase B: reconcile (ordered precedence) --------------------------------

const hit = (
  outcome: NormalizedOutcome,
  reviewReason: ReviewReason,
  note: string,
): RuleHit => ({
  outcome,
  reviewReason,
  note,
});

/** Rule 1 — telephony saw no human, yet the LLM reported a human-only signal.
 *  Counts both a mapped human label AND a derived callback (a valid callbackAt
 *  implies someone agreed a time — impossible if nobody answered). */
const ruleConflict: Rule = (signals) => {
  const humanPresent =
    HUMAN_PRESENT_OUTCOMES.has(signals.insightKey) ||
    signals.insightOutcome === NormalizedOutcome.CallbackScheduled;
  return NO_CONTACT_KINDS.has(signals.telephony) && humanPresent
    ? hit(
        NormalizedOutcome.Unknown,
        ReviewReason.Conflict,
        `CONFLICT: telephony=${signals.telephony} vs human signal "${signals.insightKey || "callbackAt"}" → review`,
      )
    : null;
};

/** Rule 2 — a successful payment link is a system-side fact (sent ≠ paid). */
const rulePaymentLink: Rule = (signals) =>
  signals.paymentLinkSent
    ? hit(
        NormalizedOutcome.WaitPaymentConfirmation,
        ReviewReason.None,
        "payment link sent → wait_payment_confirmation (sent ≠ paid)",
      )
    : null;

/** Rule 3 — answering machine / voicemail. */
const ruleVoicemail: Rule = (signals) =>
  signals.telephony === TelephonyKind.Voicemail
    ? hit(
        NormalizedOutcome.VoiceMail,
        ReviewReason.None,
        "amd machine → voice_mail",
      )
    : null;

/** Rule 4 — no contact (no-answer / busy / failed). */
const ruleNoContact: Rule = (signals) =>
  signals.telephony === TelephonyKind.NoContact
    ? hit(
        NormalizedOutcome.NoAnswer,
        ReviewReason.None,
        "telephony no_contact → no_answer",
      )
    : null;

/** Rule 5 — short connected call with no stronger human outcome (evaluable now). */
const ruleShortCall: Rule = (signals) =>
  signals.telephony === TelephonyKind.Short &&
  (signals.insightOutcome === null ||
    signals.insightOutcome === NormalizedOutcome.NoAnswer)
    ? hit(
        NormalizedOutcome.EarlyTermination,
        ReviewReason.None,
        "short call (<7s), no human outcome → early_termination",
      )
    : null;

/** Rule 6 — trust the mapped LLM outcome. */
const ruleInsight: Rule = (signals) =>
  signals.insightOutcome !== null
    ? hit(
        signals.insightOutcome,
        ReviewReason.None,
        `insight "${signals.insightKey}" → ${signals.insightOutcome}`,
      )
    : null;

/** Rule 7 — nothing usable → human review (always matches; the safety net). */
const ruleFallback: Rule = () =>
  hit(
    NormalizedOutcome.Unknown,
    ReviewReason.UnknownOutcome,
    "no usable signal → unknown → review",
  );

const RULES: readonly Rule[] = [
  ruleConflict,
  rulePaymentLink,
  ruleVoicemail,
  ruleNoContact,
  ruleShortCall,
  ruleInsight,
  ruleFallback,
];

/** Phase B — first matching rule wins. `ruleFallback` guarantees a result. */
export const reconcile = (signals: ExtractedSignals): Classification => {
  const signalSummary = `signals: telephony=${signals.telephony}, insightOutcome=${signals.insightOutcome ?? "none"}, paymentLinkSent=${signals.paymentLinkSent}`;
  for (const rule of RULES) {
    const ruleHit = rule(signals);
    if (ruleHit) {
      return {
        outcome: ruleHit.outcome,
        reviewReason: ruleHit.reviewReason,
        paymentLinkSent: signals.paymentLinkSent,
        audit: [signalSummary, ruleHit.note],
      };
    }
  }
  throw new Error("unreachable: ruleFallback always matches"); // satisfies the type checker
};

/** Convenience: run both phases. */
export const classify = (input: PostCallInput): Classification =>
  reconcile(extractSignals(input));
