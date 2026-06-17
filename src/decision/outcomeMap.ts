/**
 * Outcome vocabulary mapping — the per-client CONFIG SWAP POINT.
 *
 * Today this is one static table. Each Voxfit client has its own LLM-outcome
 * nomenclature, so the realistic evolution is to load this map (and the
 * human-present set) per tenant from config — without touching classify.ts.
 * Keeping it isolated here is the whole point: the engine is generic, the
 * vocabulary is data.
 */

import { NormalizedOutcome } from "./types";

/** Normalize a raw LLM outcome string to a stable lookup key.
 *  MUST be applied identically to the map keys AND the human-present set,
 *  otherwise conflict detection silently never matches. */
export const normalizeOutcomeKey = (raw?: string | null): string =>
  (raw ?? "").trim().toLowerCase();

/** Normalized LLM outcome text → engine outcome. */
export const OUTCOME_MAP: Readonly<Record<string, NormalizedOutcome>> = {
  "call rescheduled": NormalizedOutcome.CallbackScheduled,
  "accepted full payment later": NormalizedOutcome.PromiseToPay,
  "accepted payment plan later": NormalizedOutcome.PromiseToPay,
  "accepted full payment now": NormalizedOutcome.WaitPaymentConfirmation, // NOT completed — money unconfirmed
  "debt dispute": NormalizedOutcome.Disputed,
  "incorrect contact information": NormalizedOutcome.WrongContact,
  "stop contact": NormalizedOutcome.DoNotCall,
  "debt payment refusal": NormalizedOutcome.Uncooperative,
  "no answer": NormalizedOutcome.NoAnswer,
};

/**
 * Outcomes that can only be true if a human actually spoke on the call.
 * Used for conflict detection: if telephony says "no human contact" yet the LLM
 * reported one of these, the two signals contradict → route to a human.
 * Keys are normalized (trim + lowercase).
 */
export const HUMAN_PRESENT_OUTCOMES: ReadonlySet<string> = new Set([
  "accepted full payment now",
  "accepted full payment later",
  "accepted payment plan later",
  "debt dispute",
  "debt payment refusal",
  "stop contact",
  "incorrect contact information",
  "call rescheduled",
]);
