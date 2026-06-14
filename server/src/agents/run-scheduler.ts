/**
 * `npm run scheduler` — in-process scheduler for the agent jobs. Each minute it runs whichever jobs
 * are due (per their cron schedules) and sweeps job health hourly for alerts. Jobs are idempotent,
 * so this coexists with manual `npm run job -- <name>` runs and with OS cron if you prefer that.
 *
 *   npm run scheduler                  # long-running: run due jobs + hourly alert sweep
 *   npm run scheduler -- --list        # print the schedule and exit
 *   npm run scheduler -- --check-alerts# run one alert sweep and exit (good for OS-cron alerting)
 */
import { loadEnv } from "../ocr/env.js";
import { checkAlerts } from "./alerts.js";
import { registerAllJobs } from "./jobs.js";
import { listJobs, runJob } from "./orchestrator.js";
import { dueJobs } from "./scheduler.js";

async function runDue(): Promise<void> {
  for (const job of dueJobs(new Date())) {
    try {
      await runJob(job.name);
    } catch {
      /* failure is recorded in job_runs; keep the scheduler alive */
    }
  }
}

async function main(): Promise<void> {
  loadEnv();
  registerAllJobs();

  if (process.argv.includes("--list")) {
    for (const j of listJobs()) console.log(`${j.schedule.padEnd(14)} ${j.name} — ${j.description ?? ""}`);
    return;
  }
  if (process.argv.includes("--check-alerts")) {
    await checkAlerts();
    return;
  }

  console.log("PoliTracker scheduler started. Registered jobs:");
  for (const j of listJobs()) console.log(`  ${j.schedule.padEnd(14)} ${j.name}`);

  // Tick a few times a minute; a per-minute guard stops a job firing twice in its scheduled minute.
  let lastMinute = "";
  setInterval(() => {
    const now = new Date();
    const minute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;
    if (minute === lastMinute) return;
    lastMinute = minute;
    runDue().catch((e) => console.error("scheduler tick error:", e));
  }, 20_000);

  // Hourly health sweep, plus one at startup.
  setInterval(() => void checkAlerts().catch(() => {}), 3_600_000);
  await checkAlerts();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
