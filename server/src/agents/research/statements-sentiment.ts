/**
 * Deterministic, transparent sentiment for a statement's stance on a ticker — for Model A's MA1
 * sentiment-signing. Lexicon + simple negation, scored on the LOCAL context around the mention (so a
 * statement that is bullish on one name and bearish on another can score each correctly). No LLM, no
 * API spend, fully reproducible.
 *
 * It is intentionally crude — a keyword count, not language understanding — so treat it as a coarse
 * direction with the reported confidence, and keep the UNSIGNED result as the headline. An LLM
 * classifier (e.g. the existing agents/llm, the way news sentiment is done) can be swapped in behind
 * the same `Sentiment` shape for higher accuracy.
 */

const BULL = new Set([
  "bullish", "buy", "buying", "bought", "long", "undervalued", "upside", "outperform", "outperforming",
  "breakout", "soar", "soaring", "surge", "surging", "rally", "rallying", "upgrade", "upgraded",
  "accumulate", "accumulating", "optimistic", "moon", "rocket", "gains", "bull",
]);
const BEAR = new Set([
  "bearish", "sell", "selling", "sold", "short", "shorting", "overvalued", "downside", "underperform",
  "underperforming", "crash", "crashing", "plunge", "plunging", "dump", "dumping", "downgrade",
  "downgraded", "avoid", "bubble", "collapse", "collapsing", "tank", "tanking", "fraud", "scam", "bear",
]);
const BULL_PHRASES = ["all-time high", "all time high", "to the moon", "strong buy"];
const BEAR_PHRASES = ["sell-off", "sell off", "strong sell", "all-time low", "all time low"];
const NEG = new Set([
  "not", "no", "never", "without", "isn't", "aren't", "wasn't", "weren't", "don't", "doesn't", "didn't",
  "cannot", "can't", "won't", "wouldn't", "shouldn't",
]);

export interface Sentiment {
  label: "bullish" | "bearish" | "neutral";
  score: number; // net polarity (bull − bear, after negation)
  confidence: number; // 0..0.9, grows with |score| and total hits
}

/** Classify the sentiment of a chunk of text toward "the thing being discussed". */
export function classifySentiment(text: string): Sentiment {
  const s = text.toLowerCase();
  let score = 0;
  let hits = 0;
  for (const p of BULL_PHRASES) if (s.includes(p)) { score++; hits++; }
  for (const p of BEAR_PHRASES) if (s.includes(p)) { score--; hits++; }

  const tokens = s.replace(/[^a-z' ]+/g, " ").split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const pol = BULL.has(tokens[i]) ? 1 : BEAR.has(tokens[i]) ? -1 : 0;
    if (!pol) continue;
    let neg = false;
    for (let j = Math.max(0, i - 3); j < i; j++) if (NEG.has(tokens[j])) neg = true;
    score += neg ? -pol : pol;
    hits++;
  }

  const label = score > 0 ? "bullish" : score < 0 ? "bearish" : "neutral";
  const confidence = hits === 0 ? 0 : Math.min(0.9, 0.4 + 0.1 * Math.abs(score) + 0.05 * hits);
  return { label, score, confidence };
}

/**
 * Sentiment of a statement toward a specific mention, using a window around where the ticker/company
 * appears (falls back to the whole text if it can't be located).
 */
export function sentimentForMention(
  text: string,
  mention: { ticker: string; company_name: string | null; method: string },
): Sentiment {
  const lower = text.toLowerCase();
  const tk = mention.ticker.toLowerCase();
  let idx = -1;
  if (mention.company_name) idx = lower.indexOf(mention.company_name);
  if (idx < 0) idx = lower.indexOf(`$${tk}`);
  if (idx < 0) idx = lower.indexOf(`(${tk})`);
  if (idx < 0) return classifySentiment(text);
  return classifySentiment(text.slice(Math.max(0, idx - 140), idx + 140));
}
