import { listJobs, type Job } from "./orchestrator.js";

/**
 * Minimal 5-field cron matcher (min hour day-of-month month day-of-week), enough to drive the
 * agent jobs in-process. Supports wildcards, step values (e.g. every-6-hours), "a-b" ranges,
 * ranges-with-step, and comma lists — the forms the job schedules actually use. No external dep;
 * OS cron remains an option via `npm run job`.
 */
function matchField(field: string, value: number, min: number, max: number): boolean {
  return field.split(",").some((part) => {
    let step = 1;
    let range = part;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      range = part.slice(0, slash);
      step = Number(part.slice(slash + 1)) || 1;
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map(Number);
      lo = a;
      hi = b;
    } else {
      const n = Number(range);
      if (slash < 0) return value === n; // a bare number is an exact match
      lo = n;
      hi = max; // "n/step" means from n to max by step
    }
    if (value < lo || value > hi) return false;
    return (value - lo) % step === 0;
  });
}

/** True if `expr` fires at the given local time. Honors cron's dom/dow OR-quirk. */
export function cronMatches(expr: string, date: Date): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  const [min, hour, dom, mon, dow] = f;

  if (!matchField(min, date.getMinutes(), 0, 59)) return false;
  if (!matchField(hour, date.getHours(), 0, 23)) return false;
  if (!matchField(mon, date.getMonth() + 1, 1, 12)) return false;

  const domOk = matchField(dom, date.getDate(), 1, 31);
  const dowVal = date.getDay(); // 0=Sun..6=Sat
  const dowOk = matchField(dow, dowVal, 0, 6) || (dowVal === 0 && matchField(dow, 7, 0, 7));

  // Standard cron: when both day fields are restricted, either may satisfy the match.
  if (dom !== "*" && dow !== "*") return domOk || dowOk;
  return domOk && dowOk;
}

/** Registered jobs whose schedule fires at `date`. */
export function dueJobs(date: Date): Job[] {
  return listJobs().filter((j) => cronMatches(j.schedule, date));
}
