/**
 * `npm run job -- <name>` — run one agent job once, recording a job_run (status/duration/rows).
 *
 *   npm run job -- --list        # list registered jobs
 *   npm run job -- companies     # resolve traded tickers → SEC CIKs
 *
 * Jobs are idempotent/incremental, so this is safe to re-run and safe under cron.
 */
import { loadEnv } from "../ocr/env.js";
import { registerAllJobs } from "./jobs.js";
import { listJobs, runJob } from "./orchestrator.js";

async function main(): Promise<void> {
  loadEnv();
  registerAllJobs();

  const name = process.argv[2];
  if (!name || name === "--list") {
    console.log("Registered jobs:");
    for (const j of listJobs()) {
      console.log(`  ${j.name.padEnd(16)} ${j.schedule.padEnd(14)} ${j.description ?? ""}`);
    }
    return;
  }

  await runJob(name);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
