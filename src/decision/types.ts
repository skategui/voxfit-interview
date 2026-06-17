/**
 * Domain vocabulary (enums) + the public input/output contract (interfaces).
 *
 * Design choices:
 *  - String ENUMS for every closed vocabulary. Their string values are exactly
 *    the spec's literals, so the serialized JSON is byte-for-byte spec-compatible
 *    while the code gets a single, named, autocompletable source of truth.
 *  - INTERFACES for object shapes (entities) — extendable and clear in errors.
 *  - `PostCallInput` is the *parsed domain input*: external JSON is expected to be
 *    validated into these enums at the trust boundary (zod/io-ts in prod).
 *
 * Two fields are RECOMMENDED additions over the original spec (see README):
 *  - `CaseInfo.lastDecisionAt` — a watermark to reject stale/out-of-order events.
 *  Everything else mirrors the spec.
 */

// ---------------------------------------------------------------------------
// Closed vocabularies — enums
// ---------------------------------------------------------------------------

/** Lifecycle state of a collections case. `perm_excluded` / `completed` are terminal. */
export enum CaseStatus {
  Active = "active",
  TempExcluded = "temp_excluded",
  PermExcluded = "perm_excluded",
  Completed = "completed",
}

/** Telephony provider call status (Twilio-style). Open in practice; we branch on these. */
export enum CallStatus {
  Completed = "completed", // the CALL ended normally — NOT case completion
  NoAnswer = "no-answer",
  Busy = "busy",
  Failed = "failed",
}

/** Answering-machine detection. Probabilistic — false positives happen, which is
 *  why a voicemail classification only triggers a cheap, reversible reschedule. */
export enum AmdStatus {
  Human = "human",
  MachineStart = "machine_start",
  MachineEnd = "machine_end",
  Unknown = "unknown",
}

/** Outcome of a single tool invocation during the call. */
export enum ToolEventStatus {
  Success = "success",
  Failed = "failed",
}

/** Known tool names that move money-related state. `ToolEvent.name` stays an open
 *  string (other tools exist and must be ignored safely); these are the ones we act on. */
export enum ToolName {
  SendPaymentLink = "send_payment_link",
  SendPaymentPlanLink = "send_payment_plan_link",
}

/** Debtor's preferred call window (2-hour slots), or no preference. */
export enum PreferredCallWindow {
  W08_10 = "8-10",
  W10_12 = "10-12",
  W12_14 = "12-14",
  W14_16 = "14-16",
  W16_18 = "16-18",
  W18_20 = "18-20",
  Any = "any",
}

/** Days the campaign step is allowed to call on. */
export enum CallWindowDay {
  Mon = "mon",
  Tue = "tue",
  Wed = "wed",
  Thu = "thu",
  Fri = "fri",
  Sat = "sat",
  Sun = "sun",
}

/** Canonical engine outcome vocabulary (matches the spec union exactly).
 *  Note: there is no `manual_review` member — review is a *scheduled action*,
 *  while an unresolvable call's outcome is `Unknown`. */
export enum NormalizedOutcome {
  NoAnswer = "no_answer",
  VoiceMail = "voice_mail",
  EarlyTermination = "early_termination",
  CallbackScheduled = "callback_scheduled",
  PromiseToPay = "promise_to_pay",
  WaitPaymentConfirmation = "wait_payment_confirmation",
  Disputed = "disputed",
  WrongContact = "wrong_contact",
  DoNotCall = "do_not_call",
  Uncooperative = "uncooperative",
  Unknown = "unknown",
}

/** Kinds of follow-up work the engine can schedule. */
export enum ScheduledActionType {
  Call = "call",
  PaymentReminder = "payment_reminder",
  ManualReview = "manual_review",
}

/** Coarse telephony classification. `Short` (a <7s but CONNECTED call) is a
 *  separate axis from `NoContact` — a 5s call still reached a human. */
export enum TelephonyKind {
  NoContact = "no_contact",
  Voicemail = "voicemail",
  Short = "short",
  Ok = "ok",
}

/** Why a call was routed to a human, when the reason is part of classification. */
export enum ReviewReason {
  None = "",
  Conflict = "conflict",
  UnknownOutcome = "unknown_outcome",
}

// ---------------------------------------------------------------------------
// Entities — interfaces
// ---------------------------------------------------------------------------

export interface ToolEvent {
  id?: string;
  /** Open set — compared against {@link ToolName}; unknown names are ignored. */
  name: string;
  status: ToolEventStatus;
  createdAt: string; // ISO
  result?: Record<string, unknown>;
}

export interface CallWindow {
  days: CallWindowDay[];
  start: string; // HH:mm
  end: string; // HH:mm
}

export interface CallInfo {
  callSid: string;
  status?: CallStatus;
  amdStatus?: AmdStatus | null;
  durationSec?: number | null;
  performedAt: string; // ISO
}

export interface CaseInfo {
  caseId: string;
  status: CaseStatus;
  amountRemaining: number;
  currency: string;
  preferredCallWindow?: PreferredCallWindow;
  /**
   * RECOMMENDED (not in original spec): high-water mark of the last event already
   * folded into this case. Lets the engine reject stale / out-of-order
   * `CallCompleted` deliveries. Optional — the guard only fires when present.
   */
  lastDecisionAt?: string; // ISO
}

export interface StepInfo {
  stepActionId: string;
  maxAttempts?: number;
  attemptsSoFar?: number;
  retryDelayHours?: number;
  callWindow?: CallWindow;
  promiseFollowupDelayDays?: number;
}

export interface Insights {
  summary?: string;
  outcome?: string; // free-text LLM label, normalized then mapped
  paymentDate?: string | null;
  callbackAt?: string | null;
  /**
   * RECOMMENDED (not in original spec): the raw call transcript. The brief says
   * "the transcript is the source of truth", but the payload only carries derived
   * `insights`. When present we attach it to the manual-review payload so a human
   * investigator can reconstruct the conversation; the engine itself reasons over
   * the event timeline (see timeline.ts), not the prose.
   */
  transcript?: string;
}

export interface PostCallInput {
  now: string; // ISO — the authoritative clock (no Date.now() anywhere)
  timezone: string; // IANA zone, e.g. "Europe/Paris"
  call: CallInfo;
  case: CaseInfo;
  step: StepInfo;
  insights: Insights;
  toolEvents?: ToolEvent[];
}

export interface ScheduledAction {
  /**
   * Deterministic dedupe key, stable across at-least-once redelivery of the same
   * CallCompleted event (the decision is pure + uses `input.now`). Lets a downstream
   * scheduler collapse duplicate dial / reminder / review actions — the same
   * idempotency guarantee the ManualReview store already has, extended to the
   * money / dial path so a redelivered event can't double-book a call.
   */
  id: string;
  type: ScheduledActionType;
  runAt: string; // ISO (UTC)
  reason: string;
}

/** Build the deterministic {@link ScheduledAction.id}. `type` is part of the key
 *  because one (case, call) can schedule a call AND a manual_review in the same
 *  decision, so they must not collide. */
export const scheduledActionId = (
  caseId: string,
  callSid: string,
  type: ScheduledActionType,
  reason: string,
): string => `${caseId}:${callSid}:${type}:${reason}`;

export interface CasePatch {
  status?: CaseStatus;
  temporaryExclusionReason?: string | null;
  permanentExclusionReason?: string | null;
  nextActionAt?: string | null;
  paymentPromiseDate?: string | null;
}

export interface CallPatch {
  outcome: NormalizedOutcome;
  summary?: string;
  paymentLinkSent?: boolean;
}

export interface PostCallDecision {
  normalizedOutcome: NormalizedOutcome;
  casePatch: CasePatch;
  scheduledActions: ScheduledAction[];
  callPatch: CallPatch;
  warnings: string[];
  auditLog: string[];
}
