import { describe, expect, test } from "vitest";
import { msUntilNextWeeklyNudge } from "./notifier";

const DAY = 24 * 60 * 60 * 1000;

// 1970-01-04 was a Sunday.
const sundayAt = (hour: number, minute = 0, ms = 0) =>
  new Date(Date.UTC(1970, 0, 4, hour, minute, 0, ms));

describe("msUntilNextWeeklyNudge (Sunday 23:00 UTC = 20:00 ART)", () => {
  test("always lands exactly on a Sunday at 23:00 UTC", () => {
    for (let day = 0; day < 7; day++) {
      const now = new Date(Date.UTC(1970, 0, 5 + day, 11, 37, 13, 250));
      const ms = msUntilNextWeeklyNudge(now);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(7 * DAY);
      const target = new Date(now.getTime() + ms);
      expect(target.getUTCDay()).toBe(0);
      expect(target.getUTCHours()).toBe(23);
      expect(target.getUTCMinutes()).toBe(0);
    }
  });

  test("one minute before the nudge waits one minute", () => {
    expect(msUntilNextWeeklyNudge(sundayAt(22, 59))).toBe(60 * 1000);
  });

  test("exactly at the nudge waits a full week", () => {
    expect(msUntilNextWeeklyNudge(sundayAt(23))).toBe(7 * DAY);
  });

  test("just after the nudge waits almost a week", () => {
    expect(msUntilNextWeeklyNudge(sundayAt(23, 0, 1))).toBe(7 * DAY - 1);
  });
});
