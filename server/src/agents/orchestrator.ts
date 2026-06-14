import { recordJobFinish, recordJobStart } from "./db.js";
import { upsertJob } from "./db.js";

/**
 * Code orchestrator (NOT an LLM "master agent"). It's a job registry + a run wrapper that records
 * each run's outcome to job_runs, so "is it working?" is a monitoring question (health + alerts),
 * not a reasoning task. Jobs are idempotent/incremental, so a run is always safe to repeat — the
 * same philosophy as scrapers/run.ts. The scheduler (Phase 7) and the CLI both drive jobs through
 * runJob; nothing else should touch job_runs directly.
 */
export interface JobContext {
  log: (msg: string) => void;
}

export interface Job {
  name: string;
  /** Cron expression — informational until the Phase 7 scheduler consumes it. */
  schedule: string;
  description?: string;
  /** Do the work; return how many rows were added (for health/telemetry). */
  run(ctx: JobContext): Promise<{ rowsAdded?: number }>;
}

const registry = new Map<string, Job>();

export function registerJob(job: Job): void {
  registry.set(job.name, job);
  upsertJob({ name: job.name, schedule: job.schedule });
}

export function getJob(name: string): Job | undefined {
  return registry.get(name);
}

export function listJobs(): Job[] {
  return [...registry.values()];
}

/**
 * Run one registered job, bracketed by a job_runs record (running → ok/error with duration + rows).
 * Re-throws on failure so a CLI/scheduler sees a non-zero exit, but the failure is persisted first.
 */
export async function runJob(name: string, log: (msg: string) => void = console.log): Promise<void> {
  const job = registry.get(name);
  if (!job) {
    const known = [...registry.keys()].join(", ") || "none";
    throw new Error(`unknown job '${name}' (known: ${known})`);
  }

  const runId = recordJobStart(name);
  const t0 = Date.now();
  try {
    const { rowsAdded = 0 } = await job.run({ log });
    const durationMs = Date.now() - t0;
    recordJobFinish(runId, name, { status: "ok", rowsAdded, durationMs, error: null });
    log(`job '${name}' ok — ${rowsAdded} rows in ${durationMs}ms`);
  } catch (err) {
    const durationMs = Date.now() - t0;
    recordJobFinish(runId, name, {
      status: "error",
      rowsAdded: 0,
      durationMs,
      error: (err as Error).message,
    });
    log(`job '${name}' FAILED after ${durationMs}ms: ${(err as Error).message}`);
    throw err;
  }
}
