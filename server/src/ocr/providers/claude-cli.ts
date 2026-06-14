import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coerceExtraction, EXTRACTION_SCHEMA, SYSTEM_PROMPT, USER_INSTRUCTION } from "../prompt.js";
import type { ExtractedFiling, OcrProvider } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Run `claude` from the already-trusted project root (no workspace-trust prompt) and keep the page
// images INSIDE that workspace (gitignored .cache) so Read needs no extra permission/--add-dir.
const PROJECT_ROOT = process.env.CLAUDE_CLI_CWD ?? resolve(__dirname, "../../../..");
const CACHE_BASE = resolve(__dirname, "..", ".cache", "cli-ocr");

/**
 * Run `claude` and capture stdout. CRITICAL: stdin is "ignore" (/dev/null) — if it's a pipe, the CLI
 * waits for the prompt on stdin instead of using the positional arg, then exits empty.
 */
function runClaude(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, cwd: PROJECT_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`claude-cli: timed out after ${timeoutMs}ms`));
      if (code !== 0) return reject(new Error(`claude-cli: exit ${code}: ${(err || out).slice(0, 300)}`));
      resolve(out);
    });
  });
}

/**
 * OCR via the Claude Code CLI (`claude -p`) instead of the Anthropic API — vision extraction runs on
 * the user's Claude SUBSCRIPTION (OAuth) rather than pay-per-token API credits. ANTHROPIC_API_KEY is
 * stripped from the subprocess env so `claude` uses subscription auth, not the key (the key would
 * bill the API and defeat the purpose). NOT `--bare` (that forces API-key auth).
 *
 * Mechanics: write the preprocessed page images into a gitignored cache dir inside the trusted
 * workspace, run `claude -p` from the workspace root (no trust prompt), have it Read each image and
 * transcribe the PTR, and return ONLY a JSON object matching EXTRACTION_SCHEMA. We strip MCP servers,
 * project hooks, skills, and session persistence so startup is fast and can't stall. The model's text
 * comes back in the `--output-format json` envelope; we pull the JSON out and run the same
 * `coerceExtraction` normalizer every provider uses. Drop-in OcrProvider.
 *
 * Model default is "sonnet" with THINKING DISABLED (MAX_THINKING_TOKENS=0). The slowness that made
 * sonnet unusable before was its extended thinking in the agentic loop (one page didn't finish in
 * 240s); with thinking off, sonnet does a page in ~20s at ~2x haiku's confidence. Transcription
 * needs no reasoning, so this is strictly better. Override CLAUDE_CLI_MODEL=haiku (cheaper/faster on
 * trivial pages) or CLAUDE_CLI_MAX_THINKING=<n> to re-enable thinking.
 *
 * Tunables: CLAUDE_CLI_MODEL (alias, default "sonnet"), CLAUDE_CLI_MAX_THINKING (default "0"),
 * CLAUDE_CLI_BIN (default "claude"), CLAUDE_CLI_TIMEOUT_MS (per call, default 240000),
 * CLAUDE_CLI_CWD (trusted dir to run from).
 */
export function createClaudeCliProvider(): OcrProvider {
  const model = process.env.CLAUDE_CLI_MODEL ?? "sonnet";
  const bin = process.env.CLAUDE_CLI_BIN ?? "claude";
  const timeout = Number(process.env.CLAUDE_CLI_TIMEOUT_MS ?? 240_000);

  return {
    name: "claude-cli",
    async extract(pageImages: Buffer[]): Promise<ExtractedFiling> {
      mkdirSync(CACHE_BASE, { recursive: true });
      const dir = mkdtempSync(join(CACHE_BASE, "run-"));
      try {
        const paths = pageImages.map((b, i) => {
          const p = join(dir, `page-${String(i + 1).padStart(3, "0")}.png`);
          writeFileSync(p, b);
          return p;
        });

        const prompt =
          `${USER_INSTRUCTION}\n\n` +
          `The Periodic Transaction Report page images, in order, are these files:\n` +
          paths.map((p, i) => `  Page ${i + 1}: ${p}`).join("\n") +
          `\n\nUse the Read tool to view EVERY image file listed above, then transcribe the report.\n` +
          `Respond with ONLY a single JSON object conforming exactly to this JSON Schema — no prose, ` +
          `no markdown, no code fences:\n${JSON.stringify(EXTRACTION_SCHEMA)}`;

        // Force subscription (OAuth) auth: without the API key, `claude` uses the logged-in account.
        const env = { ...process.env };
        delete env.ANTHROPIC_API_KEY;
        // Disable extended thinking — it's what made sonnet slow here, and OCR transcription needs none.
        env.MAX_THINKING_TOKENS = process.env.CLAUDE_CLI_MAX_THINKING ?? "0";

        const stdout = await runClaude(
          bin,
          [
            "-p",
            "--output-format", "json",
            "--model", model,
            "--allowedTools", "Read", // pre-allow Read so a non-interactive run doesn't block on a prompt
            "--max-turns", String(pageImages.length + 4),
            // Keep startup minimal (and OAuth, so NOT --bare): no MCP servers (their health-check
            // spawns can stall for minutes), no project/local settings (skip hooks), no skills, no
            // session files.
            "--strict-mcp-config",
            "--mcp-config", '{"mcpServers":{}}',
            "--setting-sources", "user",
            "--disable-slash-commands",
            "--no-session-persistence",
            "--append-system-prompt", SYSTEM_PROMPT,
            prompt,
          ],
          env,
          timeout,
        );

        return coerceExtraction(parseCliResult(stdout));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** Extract the transcription JSON from the `claude -p --output-format json` envelope. */
function parseCliResult(stdout: string): unknown {
  let envelope: { is_error?: boolean; subtype?: string; result?: unknown };
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(`claude-cli: unparseable CLI envelope: ${stdout.slice(0, 200)}`);
  }
  if (envelope.is_error || (envelope.subtype && envelope.subtype !== "success")) {
    throw new Error(`claude-cli: ${envelope.subtype ?? "error"}: ${String(envelope.result ?? "").slice(0, 200)}`);
  }
  const text = typeof envelope.result === "string" ? envelope.result : JSON.stringify(envelope.result ?? "");
  // The result should be the JSON object (possibly fenced); take the outermost {...}.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(`claude-cli: no JSON object in result: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
}
