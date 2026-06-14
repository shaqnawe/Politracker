import Anthropic from "@anthropic-ai/sdk";

/**
 * Text-LLM client for the research agent (the ONLY place an LLM is used in the agents system —
 * collection stays deterministic). Uses a cheap model by default for relevance + summarization,
 * forces a tool call for structured output, and caches the system prompt (it's identical across
 * every batch, so caching cuts cost/latency materially).
 */
let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set (needed for the research agent)");
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

export const NEWS_MODEL = process.env.ANTHROPIC_NEWS_MODEL ?? "claude-haiku-4-5-20251001";

export const EVENT_TYPES = [
  "earnings",
  "m_and_a",
  "legal_regulatory",
  "product",
  "management",
  "analyst_rating",
  "macro",
  "other",
] as const;
export const SENTIMENTS = ["positive", "negative", "neutral"] as const;

export interface HeadlineInput {
  title: string;
  source: string | null;
}

export interface NewsClassification {
  relevant: boolean;
  event_type: (typeof EVENT_TYPES)[number];
  sentiment: (typeof SENTIMENTS)[number];
  summary: string;
}

const SYSTEM = `You triage financial news HEADLINES for an app that shows context around the
stocks U.S. politicians trade. For each headline decide:
- relevant: true only if it concerns the company's business, stock, financials, leadership, legal/
  regulatory status, or products. false for unrelated mentions, generic "best stocks to buy"
  listicles, and spam.
- event_type: one of earnings | m_and_a | legal_regulatory | product | management | analyst_rating |
  macro | other.
- sentiment: positive | negative | neutral, from the company's perspective.
- summary: ONE short factual clause derived ONLY from the headline. Never invent facts not in the
  headline; if the headline is too thin, restate it plainly.
Return one result per headline, in the same order. Do not skip any.`;

const TOOL: Anthropic.Tool = {
  name: "classify_headlines",
  description: "Return a relevance/sentiment/event/summary verdict for each headline, in order.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["relevant", "event_type", "sentiment", "summary"],
          properties: {
            relevant: { type: "boolean" },
            event_type: { type: "string", enum: EVENT_TYPES as unknown as string[] },
            sentiment: { type: "string", enum: SENTIMENTS as unknown as string[] },
            summary: { type: "string" },
          },
        },
      },
    },
  },
};

/** Classify a batch of headlines for one company. Returns results aligned to the input order. */
export async function classifyHeadlines(
  company: string,
  headlines: HeadlineInput[],
): Promise<NewsClassification[]> {
  if (headlines.length === 0) return [];
  const list = headlines
    .map((h, i) => `${i + 1}. ${h.title}${h.source ? ` (${h.source})` : ""}`)
    .join("\n");

  const msg = await anthropic().messages.create({
    model: NEWS_MODEL,
    max_tokens: 4096,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    tools: [TOOL],
    tool_choice: { type: "tool", name: "classify_headlines" },
    messages: [{ role: "user", content: `Company: ${company}\n\nHeadlines:\n${list}` }],
  });

  const block = msg.content.find((b) => b.type === "tool_use");
  const results = (block && "input" in block ? (block.input as any).results : []) ?? [];
  return results as NewsClassification[];
}

// --- Financial-review agent ------------------------------------------------------------------

/** Stronger model for the analytical review; defaults to the cheap model, override for production. */
export const REVIEW_MODEL = process.env.ANTHROPIC_REVIEW_MODEL ?? NEWS_MODEL;

export const FINANCIAL_FLAGS = [
  "revenue_growth",
  "revenue_decline",
  "profit_growth",
  "net_loss",
  "margin_expansion",
  "margin_compression",
  "eps_growth",
  "eps_decline",
  "large_buyback",
  "buyback_reduced",
  "asset_growth",
] as const;

export interface FinancialReview {
  narrative: string;
  flags: string[];
}

const REVIEW_SYSTEM = `You review a company's recent ANNUAL financials for an app that adds context
to U.S. politician stock trades. You receive a few fiscal years of: revenue, net income, diluted
EPS, total assets, and stock buybacks (USD; EPS in USD/share). Using ONLY these numbers:
- narrative: 1-2 neutral, factual sentences on the trend (growth or decline, profitability,
  buyback activity). Describe directions; give NO investment advice and invent NO metric you were
  not given.
- flags: zero or more from the allowed list that the numbers clearly support. Be conservative —
  only flag what the data shows.`;

const REVIEW_TOOL: Anthropic.Tool = {
  name: "financial_review",
  description: "A short grounded narrative and structured flags for a company's recent financials.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["narrative", "flags"],
    properties: {
      narrative: { type: "string" },
      flags: { type: "array", items: { type: "string", enum: FINANCIAL_FLAGS as unknown as string[] } },
    },
  },
};

/** Ask the LLM for a grounded review of one company's financials (passed as a compact table). */
export async function reviewFinancials(company: string, table: string): Promise<FinancialReview> {
  const msg = await anthropic().messages.create({
    model: REVIEW_MODEL,
    max_tokens: 1024,
    system: [{ type: "text", text: REVIEW_SYSTEM, cache_control: { type: "ephemeral" } }],
    tools: [REVIEW_TOOL],
    tool_choice: { type: "tool", name: "financial_review" },
    messages: [{ role: "user", content: `Company: ${company}\n\nAnnual financials:\n${table}` }],
  });
  const block = msg.content.find((b) => b.type === "tool_use");
  const input = (block && "input" in block ? (block.input as any) : {}) ?? {};
  return { narrative: input.narrative ?? "", flags: Array.isArray(input.flags) ? input.flags : [] };
}
