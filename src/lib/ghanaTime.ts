/**
 * Local dates for the till.
 *
 * The shop is in Accra: GMT, with no daylight saving, ever. Using the browser's
 * own timezone would put a boundary in the wrong place twice a year and, for a
 * till used abroad or a machine with a mis-set clock, all the time.
 *
 * Every "today" in a report is therefore computed in Ghana time, from the UTC
 * instant plus no offset. The consequence is that a date range always means the
 * same set of sales, whatever the machine's clock says.
 */

/** Accra is UTC+0 all year, so the offset is a constant, not a DST rule. */
export const GHANA_OFFSET_MINUTES = 0;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Formats an instant as `YYYY-MM-DD` in Ghana time. */
export function ghanaDateString(instant: Date | number = new Date()): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  const shifted = new Date(date.getTime() + GHANA_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/** The first instant of a `YYYY-MM-DD` day in Ghana time. */
export function startOfGhanaDay(day: string): Date {
  assertDayString(day);
  return new Date(`${day}T00:00:00.000Z`);
}

/** The first instant of the day *after* the given one. */
export function endOfGhanaDay(day: string): Date {
  assertDayString(day);
  return new Date(startOfGhanaDay(day).getTime() + MS_PER_DAY);
}

/**
 * Inclusive list of day strings between two dates.
 *
 * End date is inclusive, which is what a person means by "the 1st to the 5th".
 */
export function ghanaDateRange(fromDay: string, toDay: string): string[] {
  assertDayString(fromDay);
  assertDayString(toDay);
  const start = startOfGhanaDay(fromDay).getTime();
  const end = startOfGhanaDay(toDay).getTime();
  if (end < start) return [];

  const days: string[] = [];
  for (let cursor = start; cursor <= end; cursor += MS_PER_DAY) {
    days.push(ghanaDateString(new Date(cursor)));
  }
  return days;
}

/** Adds whole days to a `YYYY-MM-DD` string. */
export function addDays(day: string, days: number): string {
  assertDayString(day);
  return ghanaDateString(new Date(startOfGhanaDay(day).getTime() + days * MS_PER_DAY));
}

/** `YYYY-MM-DD` for today in Ghana, or `days` ago. */
export function ghanaToday(offsetDays = 0): string {
  return addDays(ghanaDateString(), offsetDays);
}

/** A readable, unambiguous day for a report heading. */
export function formatGhanaDay(day: string): string {
  assertDayString(day);
  const date = new Date(`${day}T00:00:00.000Z`);
  return date.toLocaleDateString('en-GB', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

/** `HH:MM` in Ghana time. */
export function ghanaTimeString(instant: Date | number = new Date()): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  const shifted = new Date(date.getTime() + GHANA_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(11, 16);
}

function assertDayString(day: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) {
    throw new RangeError(`Expected a date as YYYY-MM-DD, got ${JSON.stringify(day)}`);
  }
  // Rejects 2026-02-31 and friends, which `new Date` would roll over silently.
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    throw new RangeError(`${day} is not a real date.`);
  }
}