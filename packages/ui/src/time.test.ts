import { utcToZonedTime } from "date-fns-tz";
import { getPlanDate } from "../../core/src/planOfDay/date";

test.each([
  ["2026-03-08T12:59:59Z", "America/Chicago", "2026-03-07"],
  ["2026-03-08T13:00:00Z", "America/Chicago", "2026-03-08"],
  ["2026-11-01T13:59:59Z", "America/Chicago", "2026-10-31"],
  ["2026-11-01T14:00:00Z", "America/Chicago", "2026-11-01"],
  ["2026-10-06T05:00:00Z", "America/Chicago", "2026-10-05"],
  ["2026-10-06T14:00:00Z", "America/Los_Angeles", "2026-10-05"],
  ["2026-10-06T14:00:00Z", "Asia/Tokyo", "2026-10-06"],
])("planning day at %s in %s is %s", (instant, zone, expected) => {
  expect(getPlanDate(utcToZonedTime(new Date(instant), zone))).toBe(expected);
});
