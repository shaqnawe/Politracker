import { execFileSync } from "node:child_process";
import { loadEnv } from "../env.js";
import type { OcrProvider } from "../types.js";
import { createClaudeProvider } from "./claude.js";
import { createClaudeCliProvider } from "./claude-cli.js";
import { createOpenAiProvider } from "./openai.js";

/** Is the Claude Code CLI on PATH? (Lets us OCR on a subscription, no API credits.) */
function hasClaudeCli(): boolean {
  if (process.env.CLAUDE_CLI === "0") return false;
  try {
    execFileSync(process.env.CLAUDE_CLI_BIN ?? "claude", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Every usable provider (so `ocr:eval` can compare them). API-key providers first so they stay the
 *  default; the CLI (subscription) provider is opt-in via OCR_PROVIDER=claude-cli, or the only option
 *  when no API keys are set. */
export function availableProviders(): OcrProvider[] {
  loadEnv();
  const list: OcrProvider[] = [];
  if (process.env.ANTHROPIC_API_KEY) list.push(createClaudeProvider());
  if (process.env.OPENAI_API_KEY) list.push(createOpenAiProvider());
  if (hasClaudeCli()) list.push(createClaudeCliProvider());
  return list;
}

/** The active provider for production OCR, chosen by OCR_PROVIDER (falls back to first available). */
export function defaultProvider(): OcrProvider | undefined {
  loadEnv();
  const pref = (process.env.OCR_PROVIDER ?? "").toLowerCase();
  const all = availableProviders();
  return all.find((p) => p.name === pref) ?? all[0];
}
