import { DateTime } from "luxon";

export function computeNextReset(now: Date, timeZone: string): Date {
  return DateTime.fromJSDate(now, { zone: timeZone })
    .plus({ days: 1 })
    .startOf("day")
    .toUTC()
    .toJSDate();
}

export function isIsoDate(value: string): boolean {
  return DateTime.fromISO(value, { zone: "utc" }).isValid;
}

export function normalizeMonth(value: string | null | undefined): string {
  if (!value) {
    return "Unknown";
  }

  const dateTime = DateTime.fromISO(value, { zone: "utc" });
  if (!dateTime.isValid) {
    return "Unknown";
  }

  return dateTime.toFormat("yyyy-LL");
}
