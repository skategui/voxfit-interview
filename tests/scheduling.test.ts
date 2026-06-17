/**
 * Scheduling tests — timezone correctness, never-past, call windows, weekends,
 * 09:00 payment reminders, and DST boundaries. Times are asserted by parsing the
 * returned ISO back into Paris local time (format-independent, robust).
 */

import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  buildEffectiveWindow,
  scheduleCall,
  schedulePaymentReminder,
} from "../src/decision/schedule";
import { CallWindowDay, PreferredCallWindow } from "../src/decision/types";
import { makeInput, NOW, PARIS } from "./helpers";

const now = () => DateTime.fromISO(NOW, { zone: PARIS });
const inParis = (iso: string) => DateTime.fromISO(iso, { zone: PARIS });

describe("scheduleCall — never in the past + windows", () => {
  it("a past desired time is moved strictly into the future", () => {
    const warnings: string[] = [];
    const runAt = scheduleCall(
      "2020-01-01T10:00:00+01:00",
      makeInput(),
      now(),
      PARIS,
      warnings,
    );
    expect(inParis(runAt) > now()).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("clamps a time before the window up to the window start (same allowed day)", () => {
    const warnings: string[] = [];
    // Thursday 08:30 desired (after now), window 10:00–12:00 → 10:00 the same day.
    const input = makeInput({
      step: {
        callWindow: { days: [CallWindowDay.Thu], start: "10:00", end: "12:00" },
      },
    });
    const runAt = scheduleCall(
      "2025-07-10T08:30:00+02:00",
      input,
      now(),
      PARIS,
      warnings,
    );
    const scheduledTime = inParis(runAt);
    expect(scheduledTime.hour).toBe(10);
    expect(scheduledTime.toISODate()).toBe("2025-07-10");
  });

  it("avoids weekends by default (Saturday → next weekday)", () => {
    const warnings: string[] = [];
    const runAt = scheduleCall(
      "2025-07-12T09:00:00+02:00",
      makeInput(),
      now(),
      PARIS,
      warnings,
    ); // Sat
    expect(inParis(runAt).weekday).toBeLessThanOrEqual(5); // Mon–Fri
  });

  it("allows weekends when callWindow.days includes them", () => {
    const warnings: string[] = [];
    const input = makeInput({
      step: {
        callWindow: {
          days: [CallWindowDay.Sat, CallWindowDay.Sun],
          start: "08:00",
          end: "20:00",
        },
      },
    });
    const runAt = scheduleCall(
      "2025-07-12T09:00:00+02:00",
      input,
      now(),
      PARIS,
      warnings,
    ); // Sat
    expect(inParis(runAt).weekday).toBe(6); // stays Saturday
  });

  it("invalid date → falls back to now + retryDelay (+ warning)", () => {
    const warnings: string[] = [];
    const runAt = scheduleCall(
      "not-a-date",
      makeInput(),
      now(),
      PARIS,
      warnings,
    );
    expect(inParis(runAt) > now()).toBe(true);
    expect(warnings.some((message) => message.includes("invalid date"))).toBe(
      true,
    );
  });
});

describe("schedulePaymentReminder — 09:00 local + DST", () => {
  it("fires at 09:00 Paris on the promised date", () => {
    const warnings: string[] = [];
    const runAt = schedulePaymentReminder("2025-07-15", now(), PARIS, warnings);
    const reminderTime = inParis(runAt);
    expect(reminderTime.hour).toBe(9);
    expect(reminderTime.toISODate()).toBe("2025-07-15");
  });

  it("is DST-correct on the spring-forward day (2025-03-30)", () => {
    const warnings: string[] = [];
    const earlyMarch = DateTime.fromISO("2025-03-01T08:00:00+01:00", {
      zone: PARIS,
    });
    const runAt = schedulePaymentReminder(
      "2025-03-30",
      earlyMarch,
      PARIS,
      warnings,
    );
    const reminderTime = inParis(runAt);
    expect(reminderTime.hour).toBe(9);
    expect(reminderTime.toISODate()).toBe("2025-03-30");
  });

  it("is DST-correct on the fall-back day (2025-10-26)", () => {
    const warnings: string[] = [];
    const earlyOctober = DateTime.fromISO("2025-10-01T08:00:00+02:00", {
      zone: PARIS,
    });
    const runAt = schedulePaymentReminder(
      "2025-10-26",
      earlyOctober,
      PARIS,
      warnings,
    );
    const reminderTime = inParis(runAt);
    expect(reminderTime.hour).toBe(9);
    expect(reminderTime.toISODate()).toBe("2025-10-26");
  });

  it("a past reminder time is rolled forward (+ warning)", () => {
    const warnings: string[] = [];
    const runAt = schedulePaymentReminder("2020-01-01", now(), PARIS, warnings);
    expect(inParis(runAt) > now()).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("buildEffectiveWindow — window reconciliation", () => {
  it("intersects debtor preference with the step window", () => {
    const warnings: string[] = [];
    const input = makeInput({
      case: { preferredCallWindow: PreferredCallWindow.W08_10 },
      step: {
        callWindow: { days: [CallWindowDay.Thu], start: "09:00", end: "17:00" },
      },
    });
    const window = buildEffectiveWindow(input, warnings);
    expect(window.startMin).toBe(9 * 60); // max(09:00, 08:00)
    expect(window.endMin).toBe(10 * 60); // min(17:00, 10:00)
  });

  it("falls back to the step window when preference does not overlap (+ warning)", () => {
    const warnings: string[] = [];
    const input = makeInput({
      case: { preferredCallWindow: PreferredCallWindow.W18_20 },
      step: {
        callWindow: { days: [CallWindowDay.Thu], start: "09:00", end: "12:00" },
      },
    });
    const window = buildEffectiveWindow(input, warnings);
    expect(window.startMin).toBe(9 * 60);
    expect(window.endMin).toBe(12 * 60);
    expect(
      warnings.some((message) => message.includes("does not overlap")),
    ).toBe(true);
  });

  it("ignores an inverted time range (start > end) → safe business-hours default + warning", () => {
    const warnings: string[] = [];
    const input = makeInput({
      step: {
        callWindow: { days: [CallWindowDay.Thu], start: "18:00", end: "08:00" },
      },
    });
    const window = buildEffectiveWindow(input, warnings);
    expect(window.startMin).toBe(8 * 60); // falls back to business hours, NOT all-day
    expect(window.endMin).toBe(20 * 60);
    expect(
      warnings.some((message) => message.includes("invalid step.callWindow")),
    ).toBe(true);
  });

  it("with no callWindow configured, defaults to business hours (no off-hours dialing)", () => {
    const warnings: string[] = [];
    const window = buildEffectiveWindow(makeInput(), warnings);
    expect(window.startMin).toBe(8 * 60);
    expect(window.endMin).toBe(20 * 60);
  });
});
