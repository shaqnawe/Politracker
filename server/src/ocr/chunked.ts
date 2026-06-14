import type { ExtractedFiling, OcrProvider } from "./types.js";

/**
 * TPM-resilient extraction for large scanned filings. A 20–40 page PTR sent as one vision request
 * blows past constrained per-minute token caps (OpenAI's 30k TPM → HTTP 429), and chunking alone
 * doesn't help because TPM is a *per-minute* budget: several chunks in one minute still sum past it.
 * So we (a) split pages into small chunks each well under one request's limit, (b) space chunks out
 * so each lands in its own TPM window, and (c) retry any 429 after a minute (the window resets).
 *
 * Filing-level fields (filer_name, filing_date) come from the FIRST chunk (the header page);
 * transactions are concatenated across chunks. No page overlap → each transaction row is read once.
 */
export interface ChunkOptions {
  /** Pages per vision request. Small enough that one chunk can't exceed a single-request limit. */
  maxPagesPerChunk?: number;
  /** Pause between chunks so each falls in its own per-minute token window (ms). */
  spacingMs?: number;
  /** Retries on a 429 / "request too large" before giving up. */
  retries?: number;
  /** Backoff per 429 (ms); the TPM window resets each minute, so ~60s is the natural wait. */
  backoffMs?: number;
  onLog?: (m: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A 429 / rate-limit / "request too large" error from either provider SDK. */
export function isRateLimit(err: unknown): boolean {
  const e = err as { status?: number; message?: string } | undefined;
  if (e?.status === 429) return true;
  return /\b429\b|rate.?limit|too large|tokens per min|TPM/i.test(e?.message ?? "");
}

/**
 * A BILLING/quota-exhaustion error — also surfaced as HTTP 429 but NOT retryable: waiting and
 * retrying can't refill credits. Distinguished from the per-minute rate limit so the runner aborts
 * the whole batch immediately instead of burning retries on every remaining filing.
 */
export function isQuotaError(err: unknown): boolean {
  const e = err as { status?: number; code?: string; message?: string } | undefined;
  if (e?.code === "insufficient_quota") return true;
  return /exceeded your current quota|insufficient_quota|check your plan and billing|credit balance is too low/i.test(
    e?.message ?? "",
  );
}

async function extractWithRetry(
  provider: OcrProvider,
  images: Buffer[],
  retries: number,
  backoffMs: number,
  log?: (m: string) => void,
): Promise<ExtractedFiling> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await provider.extract(images);
    } catch (err) {
      if (isQuotaError(err)) throw err; // out of credits — retrying can't help
      if (!isRateLimit(err) || attempt >= retries) throw err;
      log?.(`    rate-limited; waiting ${Math.round(backoffMs / 1000)}s then retry (${attempt + 1}/${retries})`);
      await sleep(backoffMs);
    }
  }
}

export async function extractChunked(
  provider: OcrProvider,
  pages: Buffer[],
  opts: ChunkOptions = {},
): Promise<ExtractedFiling> {
  const max = opts.maxPagesPerChunk ?? 8;
  const spacingMs = opts.spacingMs ?? 60_000;
  const retries = opts.retries ?? 5;
  const backoffMs = opts.backoffMs ?? 60_000;

  // Small filing: a single request (now also 429-resilient), identical output to before.
  if (pages.length <= max) {
    return extractWithRetry(provider, pages, retries, backoffMs, opts.onLog);
  }

  const chunks: Buffer[][] = [];
  for (let i = 0; i < pages.length; i += max) chunks.push(pages.slice(i, i + max));
  opts.onLog?.(`    large filing: ${pages.length} pages → ${chunks.length} chunks of ≤${max}`);

  let merged: ExtractedFiling | null = null;
  for (let ci = 0; ci < chunks.length; ci++) {
    if (ci > 0) await sleep(spacingMs);
    opts.onLog?.(`    chunk ${ci + 1}/${chunks.length} (${chunks[ci].length} pages)`);
    const part = await extractWithRetry(provider, chunks[ci], retries, backoffMs, opts.onLog);
    if (!merged) {
      merged = {
        filing: part.filing, // header fields from the first chunk
        transactions: [...part.transactions],
        extraction_notes: part.extraction_notes,
      };
    } else {
      merged.transactions.push(...part.transactions);
    }
  }
  return merged!;
}
