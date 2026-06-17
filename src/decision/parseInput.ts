/**
 * Trust-boundary parser: untrusted JSON (`unknown`) → a typed PostCallInput, or a
 * structured list of errors.
 *
 * `buildPostCallDecision` assumes the *parsed* domain shape (see the note atop
 * types.ts). THIS is where that assumption is enforced. A malformed webhook payload
 * fails loudly here instead of:
 *  - throwing deep in the pipeline (`Cannot read properties of undefined`), or
 *  - WORSE: silently completing a case — a non-finite `amountRemaining` slips past
 *    the `remaining > 0` guard and the debt is dropped with no human in the loop.
 *
 * Policy:
 *  - REJECT on the closed contract: missing/!ISO `now`, invalid IANA `timezone`,
 *    missing ids, non-finite `amountRemaining`, unknown `case.status`.
 *  - COERCE/DROP on the OPEN fields the engine already treats as optional: an
 *    unknown `call.status` / `amdStatus` becomes undefined (telephony degrades
 *    safely); `insights` defaults to {}. We don't reject a whole event over a
 *    carrier label we don't recognize.
 */

import { DateTime, IANAZone } from "luxon";
import {
  AmdStatus,
  CallStatus,
  CallWindowDay,
  CaseStatus,
  PreferredCallWindow,
  ToolEventStatus,
} from "./types";
import type {
  CallInfo,
  CallWindow,
  CaseInfo,
  Insights,
  PostCallInput,
  StepInfo,
  ToolEvent,
} from "./types";

export type ParseResult =
  | { ok: true; input: PostCallInput }
  | { ok: false; errors: string[] };

// --- Primitives -------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isIso = (v: unknown): v is string =>
  typeof v === "string" && DateTime.fromISO(v, { setZone: true }).isValid;

/** Membership test against a string enum's VALUES (returns the typed member or undefined). */
const asEnum = <T extends Record<string, string>>(
  e: T,
  v: unknown,
): T[keyof T] | undefined =>
  typeof v === "string" && (Object.values(e) as string[]).includes(v)
    ? (v as T[keyof T])
    : undefined;

const optionalFiniteNumber = (
  v: unknown,
  label: string,
  errors: string[],
): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  errors.push(`${label}: must be a finite number (got ${JSON.stringify(v)})`);
  return undefined;
};

const optionalString = (
  v: unknown,
  label: string,
  errors: string[],
): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v === "string") return v;
  errors.push(`${label}: must be a string`);
  return undefined;
};

/** string | null (the shape of paymentDate / callbackAt). */
const nullableString = (
  v: unknown,
  label: string,
  errors: string[],
): string | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null || typeof v === "string") return v;
  errors.push(`${label}: must be a string or null`);
  return undefined;
};

// --- Sub-parsers ------------------------------------------------------------

const parseCall = (raw: unknown, errors: string[]): CallInfo | null => {
  if (!isObject(raw)) {
    errors.push("call: required object");
    return null;
  }
  const callSid =
    typeof raw.callSid === "string" && raw.callSid ? raw.callSid : null;
  if (!callSid) errors.push("call.callSid: required non-empty string");
  const performedAt = isIso(raw.performedAt) ? raw.performedAt : null;
  if (!performedAt)
    errors.push(
      `call.performedAt: invalid or missing ISO (${JSON.stringify(raw.performedAt)})`,
    );

  // Open fields — coerce an unrecognized value to undefined, never reject the event.
  const status = asEnum(CallStatus, raw.status);
  const amdStatus =
    raw.amdStatus === null ? null : asEnum(AmdStatus, raw.amdStatus);
  const durationSec =
    raw.durationSec === null
      ? null
      : optionalFiniteNumber(raw.durationSec, "call.durationSec", errors);

  if (!callSid || !performedAt) return null;
  return {
    callSid,
    performedAt,
    ...(status !== undefined ? { status } : {}),
    ...(amdStatus !== undefined ? { amdStatus } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
  };
};

const parseCase = (raw: unknown, errors: string[]): CaseInfo | null => {
  if (!isObject(raw)) {
    errors.push("case: required object");
    return null;
  }
  const caseId =
    typeof raw.caseId === "string" && raw.caseId ? raw.caseId : null;
  if (!caseId) errors.push("case.caseId: required non-empty string");
  const status = asEnum(CaseStatus, raw.status);
  if (!status)
    errors.push(
      `case.status: must be active|temp_excluded|perm_excluded|completed (got ${JSON.stringify(raw.status)})`,
    );
  // The crux: a non-finite amount is a malformed payload, not a settled case.
  const amountRemaining =
    typeof raw.amountRemaining === "number" &&
    Number.isFinite(raw.amountRemaining)
      ? raw.amountRemaining
      : null;
  if (amountRemaining === null)
    errors.push(
      `case.amountRemaining: required finite number (got ${JSON.stringify(raw.amountRemaining)})`,
    );
  const currency =
    typeof raw.currency === "string" && raw.currency ? raw.currency : null;
  if (!currency) errors.push("case.currency: required non-empty string");

  const preferredCallWindow = asEnum(
    PreferredCallWindow,
    raw.preferredCallWindow,
  );
  if (raw.preferredCallWindow !== undefined && !preferredCallWindow)
    errors.push(
      `case.preferredCallWindow: invalid window (${JSON.stringify(raw.preferredCallWindow)})`,
    );

  let lastDecisionAt: string | undefined;
  if (raw.lastDecisionAt !== undefined) {
    if (isIso(raw.lastDecisionAt)) lastDecisionAt = raw.lastDecisionAt;
    else
      errors.push(
        `case.lastDecisionAt: invalid ISO (${JSON.stringify(raw.lastDecisionAt)})`,
      );
  }

  if (!caseId || !status || amountRemaining === null || !currency) return null;
  return {
    caseId,
    status,
    amountRemaining,
    currency,
    ...(preferredCallWindow ? { preferredCallWindow } : {}),
    ...(lastDecisionAt !== undefined ? { lastDecisionAt } : {}),
  };
};

const parseCallWindow = (
  raw: unknown,
  errors: string[],
): CallWindow | undefined => {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    errors.push("step.callWindow: must be an object");
    return undefined;
  }
  let days: CallWindowDay[] | null = null;
  if (Array.isArray(raw.days)) {
    const mapped = raw.days.map((d) => asEnum(CallWindowDay, d));
    if (mapped.some((d) => d === undefined))
      errors.push("step.callWindow.days: contains invalid day name(s)");
    else days = mapped as CallWindowDay[];
  } else {
    errors.push("step.callWindow.days: must be an array of day names");
  }
  // HH:mm format is tolerated downstream (schedule.ts warns + ignores); shape only here.
  const start = typeof raw.start === "string" ? raw.start : null;
  const end = typeof raw.end === "string" ? raw.end : null;
  if (start === null)
    errors.push("step.callWindow.start: required HH:mm string");
  if (end === null) errors.push("step.callWindow.end: required HH:mm string");

  if (!days || start === null || end === null) return undefined;
  return { days, start, end };
};

const parseStep = (raw: unknown, errors: string[]): StepInfo | null => {
  if (!isObject(raw)) {
    errors.push("step: required object");
    return null;
  }
  const stepActionId =
    typeof raw.stepActionId === "string" && raw.stepActionId
      ? raw.stepActionId
      : null;
  if (!stepActionId)
    errors.push("step.stepActionId: required non-empty string");
  const maxAttempts = optionalFiniteNumber(
    raw.maxAttempts,
    "step.maxAttempts",
    errors,
  );
  const attemptsSoFar = optionalFiniteNumber(
    raw.attemptsSoFar,
    "step.attemptsSoFar",
    errors,
  );
  const retryDelayHours = optionalFiniteNumber(
    raw.retryDelayHours,
    "step.retryDelayHours",
    errors,
  );
  const promiseFollowupDelayDays = optionalFiniteNumber(
    raw.promiseFollowupDelayDays,
    "step.promiseFollowupDelayDays",
    errors,
  );
  const callWindow = parseCallWindow(raw.callWindow, errors);

  if (!stepActionId) return null;
  return {
    stepActionId,
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(attemptsSoFar !== undefined ? { attemptsSoFar } : {}),
    ...(retryDelayHours !== undefined ? { retryDelayHours } : {}),
    ...(promiseFollowupDelayDays !== undefined
      ? { promiseFollowupDelayDays }
      : {}),
    ...(callWindow !== undefined ? { callWindow } : {}),
  };
};

const parseInsights = (raw: unknown, errors: string[]): Insights => {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) {
    errors.push("insights: must be an object");
    return {};
  }
  const insights: Insights = {};
  const summary = optionalString(raw.summary, "insights.summary", errors);
  if (summary !== undefined) insights.summary = summary;
  const outcome = optionalString(raw.outcome, "insights.outcome", errors);
  if (outcome !== undefined) insights.outcome = outcome;
  const transcript = optionalString(
    raw.transcript,
    "insights.transcript",
    errors,
  );
  if (transcript !== undefined) insights.transcript = transcript;
  const paymentDate = nullableString(
    raw.paymentDate,
    "insights.paymentDate",
    errors,
  );
  if (paymentDate !== undefined) insights.paymentDate = paymentDate;
  const callbackAt = nullableString(
    raw.callbackAt,
    "insights.callbackAt",
    errors,
  );
  if (callbackAt !== undefined) insights.callbackAt = callbackAt;
  return insights;
};

const parseToolEvents = (
  raw: unknown,
  errors: string[],
): ToolEvent[] | undefined => {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    errors.push("toolEvents: must be an array");
    return undefined;
  }
  const events: ToolEvent[] = [];
  raw.forEach((item, i) => {
    if (!isObject(item)) {
      errors.push(`toolEvents[${i}]: must be an object`);
      return;
    }
    const name = typeof item.name === "string" && item.name ? item.name : null;
    if (!name) errors.push(`toolEvents[${i}].name: required non-empty string`);
    const status = asEnum(ToolEventStatus, item.status);
    if (!status)
      errors.push(
        `toolEvents[${i}].status: must be success|failed (got ${JSON.stringify(item.status)})`,
      );
    const createdAt = isIso(item.createdAt) ? item.createdAt : null;
    if (!createdAt)
      errors.push(`toolEvents[${i}].createdAt: invalid or missing ISO`);

    let id: string | undefined;
    if (item.id !== undefined) {
      if (typeof item.id === "string") id = item.id;
      else errors.push(`toolEvents[${i}].id: must be a string`);
    }
    let result: Record<string, unknown> | undefined;
    if (item.result !== undefined) {
      if (isObject(item.result)) result = item.result;
      else errors.push(`toolEvents[${i}].result: must be an object`);
    }

    if (!name || !status || !createdAt) return;
    events.push({
      name,
      status,
      createdAt,
      ...(id !== undefined ? { id } : {}),
      ...(result !== undefined ? { result } : {}),
    });
  });
  return events;
};

// --- Public entry point -----------------------------------------------------

/**
 * Validate + normalize an untrusted payload into a {@link PostCallInput}.
 *
 * @param raw - The untrusted JSON value (e.g. a webhook body).
 * @returns `{ ok: true, input }` on success, or `{ ok: false, errors }` with a
 *          structured list of every violation (never throws).
 * @example
 * const parsed = parsePostCallInput(req.body);
 * if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
 * const decision = buildPostCallDecision(parsed.input);
 */
export const parsePostCallInput = (raw: unknown): ParseResult => {
  if (!isObject(raw))
    return { ok: false, errors: ["input: must be an object"] };
  const errors: string[] = [];

  const now = isIso(raw.now) ? raw.now : null;
  if (!now)
    errors.push(
      `now: invalid or missing ISO timestamp (${JSON.stringify(raw.now)})`,
    );
  const timezone =
    typeof raw.timezone === "string" && IANAZone.isValidZone(raw.timezone)
      ? raw.timezone
      : null;
  if (!timezone)
    errors.push(
      `timezone: invalid IANA zone (${JSON.stringify(raw.timezone)})`,
    );

  const call = parseCall(raw.call, errors);
  const caseInfo = parseCase(raw.case, errors);
  const step = parseStep(raw.step, errors);
  const insights = parseInsights(raw.insights, errors);
  const toolEvents = parseToolEvents(raw.toolEvents, errors);

  if (errors.length || !now || !timezone || !call || !caseInfo || !step)
    return { ok: false, errors: errors.length ? errors : ["input: malformed"] };

  return {
    ok: true,
    input: {
      now,
      timezone,
      call,
      case: caseInfo,
      step,
      insights,
      ...(toolEvents !== undefined ? { toolEvents } : {}),
    },
  };
};
