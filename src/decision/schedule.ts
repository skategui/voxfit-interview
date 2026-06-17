/**
 * Timezone-aware scheduling (Luxon). Pure: every function takes `now` and `zone`
 * explicitly — no Date.now(), no ambient timezone. This is what makes scheduling
 * deterministic and DST-correct.
 *
 * Invariants enforced here:
 *  - never schedule in the past;
 *  - respect the effective call window (campaign window ∩ debtor preference);
 *  - avoid weekends unless the step's callWindow.days explicitly allows them;
 *  - payment reminders fire at 09:00 local on the promised date.
 */

import { DateTime } from "luxon";
import { CallWindowDay, PreferredCallWindow } from "./types";
import type { CaseInfo, StepInfo } from "./types";

/** Everything scheduling needs: the campaign step (window, retry) + the case
 *  (debtor preference). Both a CallCompleted and a PromiseExpired event satisfy it. */
export interface SchedulingContext {
  step: StepInfo;
  case: CaseInfo;
}

// --- Constants --------------------------------------------------------------
const REMINDER_HOUR = 9;
const RETRY_FALLBACK_HOURS = 24;
const MAX_WINDOW_SCAN_DAYS = 14;
const DEFAULT_WEEKDAYS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5]); // Mon–Fri (avoid weekends)
// Safe default hours when no step.callWindow is configured. A debt-collection
// agent must never dial at 03:00 — unsociable-hours calling is regulated. So the
// floor is business hours, NOT all-day, unless a campaign explicitly widens it.
const DEFAULT_BUSINESS_START_MIN = 8 * 60; // 08:00
const DEFAULT_BUSINESS_END_MIN = 20 * 60; // 20:00

const DAY_TO_WEEKDAY: Readonly<Record<CallWindowDay, number>> = {
  [CallWindowDay.Mon]: 1,
  [CallWindowDay.Tue]: 2,
  [CallWindowDay.Wed]: 3,
  [CallWindowDay.Thu]: 4,
  [CallWindowDay.Fri]: 5,
  [CallWindowDay.Sat]: 6,
  [CallWindowDay.Sun]: 7,
};

/** Debtor preference windows, in minutes-from-midnight. `Any` = no time constraint. */
const PREFERRED_WINDOWS: Readonly<
  Record<PreferredCallWindow, [number, number] | null>
> = {
  [PreferredCallWindow.W08_10]: [8 * 60, 10 * 60],
  [PreferredCallWindow.W10_12]: [10 * 60, 12 * 60],
  [PreferredCallWindow.W12_14]: [12 * 60, 14 * 60],
  [PreferredCallWindow.W14_16]: [14 * 60, 16 * 60],
  [PreferredCallWindow.W16_18]: [16 * 60, 18 * 60],
  [PreferredCallWindow.W18_20]: [18 * 60, 20 * 60],
  [PreferredCallWindow.Any]: null,
};

// --- Types ------------------------------------------------------------------
export interface EffectiveWindow {
  days: ReadonlySet<number>; // Luxon weekday: 1=Mon … 7=Sun
  startMin: number; // minutes from midnight, inclusive
  endMin: number; // minutes from midnight, exclusive
}

// --- Date helpers -----------------------------------------------------------

/** True if `iso` parses as a valid ISO datetime/date. */
export const isValidIso = (iso?: string | null): boolean =>
  iso != null && DateTime.fromISO(iso, { setZone: true }).isValid;

/** Parse an ISO instant in the engine timezone. Invalid input → null. */
export const parseInZone = (iso: string, zone: string): DateTime | null => {
  const dt = DateTime.fromISO(iso, { zone });
  return dt.isValid ? dt : null;
};

const parseHHmm = (value: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};

const atMinutes = (dt: DateTime, minutes: number): DateTime =>
  dt.set({
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
    second: 0,
    millisecond: 0,
  });

// --- Window resolution ------------------------------------------------------

/** Allowed weekdays: explicit step.callWindow.days, else weekdays (avoid weekends). */
const resolveDays = (input: SchedulingContext): ReadonlySet<number> => {
  const days = input.step.callWindow?.days;
  return days?.length
    ? new Set(days.map((day) => DAY_TO_WEEKDAY[day]))
    : DEFAULT_WEEKDAYS;
};

/** Allowed time range = step window ∩ debtor preference. Degrades gracefully. */
const resolveTimeRange = (
  input: SchedulingContext,
  warnings: string[],
): { startMin: number; endMin: number } => {
  const callWindow = input.step.callWindow;
  // Default to safe business hours (not all-day) so an unconfigured step never
  // dials at unsociable hours. A campaign that wants 24h can set 00:00–23:59.
  let startMin = DEFAULT_BUSINESS_START_MIN;
  let endMin = DEFAULT_BUSINESS_END_MIN;

  if (callWindow) {
    const parsedStart = parseHHmm(callWindow.start);
    const parsedEnd = parseHHmm(callWindow.end);
    if (
      parsedStart === null ||
      parsedEnd === null ||
      parsedStart >= parsedEnd
    ) {
      warnings.push(
        `invalid step.callWindow "${callWindow.start}-${callWindow.end}" → ignoring time constraint`,
      );
    } else {
      [startMin, endMin] = [parsedStart, parsedEnd];
    }
  }

  const preference = input.case.preferredCallWindow;
  const preferenceRange =
    preference && preference !== PreferredCallWindow.Any
      ? PREFERRED_WINDOWS[preference]
      : null;
  if (preferenceRange) {
    const overlapStart = Math.max(startMin, preferenceRange[0]);
    const overlapEnd = Math.min(endMin, preferenceRange[1]);
    if (overlapStart >= overlapEnd)
      warnings.push(
        `preferredCallWindow ${preference} does not overlap step window → using step window`,
      );
    else [startMin, endMin] = [overlapStart, overlapEnd];
  }

  return { startMin, endMin };
};

export const buildEffectiveWindow = (
  input: SchedulingContext,
  warnings: string[],
): EffectiveWindow => {
  const { startMin, endMin } = resolveTimeRange(input, warnings);
  return { days: resolveDays(input), startMin, endMin };
};

/** Earliest valid slot at or after `target`: an allowed day, inside [startMin, endMin). */
const clampToWindow = (
  target: DateTime,
  window: EffectiveWindow,
): { dt: DateTime; adjusted: boolean } => {
  let candidate = target;
  let adjusted = false;
  // Bounded scan — a window with no allowed day would otherwise loop forever.
  for (let dayOffset = 0; dayOffset < MAX_WINDOW_SCAN_DAYS; dayOffset++) {
    const minuteOfDay = candidate.hour * 60 + candidate.minute;
    const dayAllowed = window.days.has(candidate.weekday);
    if (
      dayAllowed &&
      minuteOfDay >= window.startMin &&
      minuteOfDay < window.endMin
    )
      return { dt: candidate, adjusted };
    if (dayAllowed && minuteOfDay < window.startMin)
      return { dt: atMinutes(candidate, window.startMin), adjusted: true };
    candidate = atMinutes(candidate.plus({ days: 1 }), window.startMin); // next day's window start
    adjusted = true;
  }
  return { dt: candidate, adjusted: true };
};

// --- Public scheduling ------------------------------------------------------

/**
 * Schedule a CALL at (or after) `desiredIso`, honoring never-past + the window.
 * `desiredIso` undefined/invalid → fall back to `now + retryDelay`. Returns ISO (UTC).
 */
export const scheduleCall = (
  desiredIso: string | null | undefined,
  input: SchedulingContext,
  now: DateTime,
  zone: string,
  warnings: string[],
): string => {
  const retryHours = input.step.retryDelayHours ?? RETRY_FALLBACK_HOURS;
  const fallback = now.plus({ hours: retryHours });

  let desired = desiredIso ? parseInZone(desiredIso, zone) : null;
  if (desiredIso && !desired)
    warnings.push(`invalid date "${desiredIso}" → using now + ${retryHours}h`);
  if (!desired) desired = fallback;

  let base = desired;
  if (base <= now) {
    warnings.push(
      `requested time ${desired.toISO()} is in the past → moved forward`,
    );
    base = fallback > now ? fallback : now.plus({ minutes: 1 });
  }

  const window = buildEffectiveWindow(input, warnings);
  const clamped = clampToWindow(base.setZone(zone), window);
  let dt = clamped.dt;
  if (dt <= now)
    dt = clampToWindow(now.setZone(zone).plus({ minutes: 1 }), window).dt;

  if (clamped.adjusted || base !== desired)
    warnings.push(`call time adjusted to ${dt.toISO()} (window / never-past)`);
  return dt.toUTC().toISO() as string;
};

/**
 * Schedule a PAYMENT REMINDER at 09:00 local on the promised date.
 * Past date / already-passed 09:00 → rolled forward to a future 09:00 (+ warning).
 * DST-correct: Luxon resolves 09:00 in `zone` on the local calendar date.
 */
export const schedulePaymentReminder = (
  paymentDateIso: string,
  now: DateTime,
  zone: string,
  warnings: string[],
): string => {
  const day = parseInZone(paymentDateIso, zone);
  if (!day) {
    warnings.push(
      `invalid paymentDate "${paymentDateIso}" → reminder set to tomorrow 09:00`,
    );
    return atMinutes(now.plus({ days: 1 }), REMINDER_HOUR * 60)
      .toUTC()
      .toISO() as string;
  }

  let reminder = atMinutes(day, REMINDER_HOUR * 60);
  if (reminder <= now) {
    reminder = atMinutes(now.setZone(zone), REMINDER_HOUR * 60);
    if (reminder <= now) reminder = reminder.plus({ days: 1 });
    warnings.push(
      `payment reminder 09:00 on ${paymentDateIso} already passed → moved to ${reminder.toISO()}`,
    );
  }
  return reminder.toUTC().toISO() as string;
};
