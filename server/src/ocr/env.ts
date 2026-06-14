import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load API keys from the repo-root .env (ANTHROPIC_API_KEY, OPENAI_API_KEY, OCR_PROVIDER,
 * and optional ANTHROPIC_OCR_MODEL / OPENAI_OCR_MODEL). Node doesn't auto-load .env; this
 * is a no-op if the file is absent (keys may already be in the real environment).
 */
let loaded = false;
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
  try {
    process.loadEnvFile(root);
  } catch {
    // no .env file — rely on the ambient environment
  }
}
