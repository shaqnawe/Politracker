import { jobsHealth } from "./db.js";

/**
 * Health alerting for the orchestrator: a job is a problem if its last run errored or it hasn't
 * run successfully in too long (stale). Issues are logged and, if ALERT_WEBHOOK_URL is set, POSTed
 * there. This is the "is it working?" layer the architecture chose over an LLM master agent.
 */
export interface AlertIssue {
  job: string;
  kind: "failed" | "stale";
  detail: string;
}

const DEFAULT_STALE_HOURS = 48;

/** Jobs whose last run failed, or that are older than the staleness window. */
export function findIssues(staleHours = Number(process.env.ALERT_STALE_HOURS ?? DEFAULT_STALE_HOURS)): AlertIssue[] {
  const issues: AlertIssue[] = [];
  for (const j of jobsHealth().jobs) {
    if (!j.enabled || j.lastStatus === null) continue; // never run yet → nothing to alert on
    if (j.lastStatus === "error") {
      issues.push({ job: j.name, kind: "failed", detail: j.lastError ?? "error" });
    } else if (j.ageHours != null && j.ageHours > staleHours) {
      issues.push({ job: j.name, kind: "stale", detail: `last run ${j.ageHours.toFixed(1)}h ago` });
    }
  }
  return issues;
}

/** Find issues, log them, and POST to ALERT_WEBHOOK_URL when configured. Returns the issues. */
export async function checkAlerts(log: (msg: string) => void = console.log): Promise<AlertIssue[]> {
  const issues = findIssues();
  if (issues.length === 0) {
    log("Alerts: all jobs healthy.");
    return issues;
  }
  for (const i of issues) log(`ALERT [${i.kind}] ${i.job}: ${i.detail}`);

  const url = process.env.ALERT_WEBHOOK_URL;
  if (url) {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "politracker", at: new Date().toISOString(), issues }),
      });
      log(`Alerts: posted ${issues.length} issue(s) to webhook.`);
    } catch (err) {
      log(`Alerts: webhook POST failed: ${(err as Error).message}`);
    }
  }
  return issues;
}
