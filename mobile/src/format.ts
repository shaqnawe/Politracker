import type { TxType } from "./api";

/** BUY/SELL label + which fixed theme token carries its color. */
export function txMeta(txType: TxType): { label: string; tone: "accent" | "danger" | "accent3" | "inkFaint" } {
  switch (txType) {
    case "purchase":
      return { label: "BUY", tone: "accent" }; // green = buy
    case "sale":
      return { label: "SELL", tone: "danger" }; // red = sell
    case "sale_partial":
      return { label: "SELL (PART)", tone: "danger" };
    case "exchange":
      return { label: "EXCHANGE", tone: "accent3" };
    default:
      return { label: "OTHER", tone: "inkFaint" };
  }
}

export function chamberLabel(chamber: string): string {
  if (chamber === "senate") return "SENATE";
  if (chamber === "executive") return "EXEC";
  return "HOUSE";
}

const ASSET_CLASS_LABELS: Record<string, string> = {
  stock: "Stock",
  etf: "ETF",
  fund: "Fund",
  treasury: "Treasury",
  muni_bond: "Muni bond",
  corp_bond: "Corp bond",
  other: "Other",
};
export function assetClassLabel(c: string): string {
  return ASSET_CLASS_LABELS[c] ?? c;
}

const OWNER_LABELS: Record<string, string> = {
  self: "Self",
  spouse: "Spouse",
  joint: "Joint",
  dependent: "Dependent child",
  unknown: "—",
};

export function ownerLabel(owner: string): string {
  return OWNER_LABELS[owner] ?? owner;
}

/** ISO "2024-12-24" -> "Dec 24, 2024". */
export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[m - 1]} ${d}, ${y}`;
}

export function memberLocation(
  chamber: string,
  state: string | null,
  district: string | null,
): string {
  if (chamber === "executive") return "Executive Branch · President";
  if (chamber === "senate") return state ? `Senate · ${state}` : "Senate";
  if (state && district) return `House · ${state}-${district}`;
  if (state) return `House · ${state}`;
  return "House";
}

/** Compact money for the context screens: 416_161_000_000 -> "$416.2B". Non-USD units render raw. */
export function formatMoney(value: number, unit: string): string {
  if (unit !== "USD") return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

const METRIC_LABELS: Record<string, string> = {
  revenue: "Revenue",
  net_income: "Net income",
  eps_diluted: "EPS (diluted)",
  assets: "Total assets",
  buybacks: "Buybacks",
};
/** Fixed display order for the financials table. */
export const METRIC_ORDER = ["revenue", "net_income", "eps_diluted", "assets", "buybacks"];
export function metricLabel(metric: string): string {
  return METRIC_LABELS[metric] ?? metric;
}

const FLAG_LABELS: Record<string, string> = {
  revenue_growth: "Revenue ↑",
  revenue_decline: "Revenue ↓",
  profit_growth: "Profit ↑",
  net_loss: "Net loss",
  margin_expansion: "Margin ↑",
  margin_compression: "Margin ↓",
  eps_growth: "EPS ↑",
  eps_decline: "EPS ↓",
  large_buyback: "Large buyback",
  buyback_reduced: "Buyback ↓",
  asset_growth: "Assets ↑",
};
const FLAG_NEGATIVE = new Set(["revenue_decline", "net_loss", "margin_compression", "eps_decline"]);
const FLAG_NEUTRAL = new Set(["large_buyback", "buyback_reduced", "asset_growth"]);

/** Flag → label + fixed theme tone: gain=accent (green), loss=danger (red), neutral=accent2 (amber). */
export function flagMeta(flag: string): { label: string; tone: "accent" | "danger" | "accent2" } {
  const tone = FLAG_NEGATIVE.has(flag) ? "danger" : FLAG_NEUTRAL.has(flag) ? "accent2" : "accent";
  return { label: FLAG_LABELS[flag] ?? flag.replace(/_/g, " "), tone };
}

const EVENT_LABELS: Record<string, string> = {
  earnings: "Earnings",
  m_and_a: "M&A",
  legal_regulatory: "Legal/Reg",
  product: "Product",
  management: "Management",
  analyst_rating: "Analyst",
  macro: "Macro",
  other: "News",
};
export function eventLabel(e: string | null): string {
  return e ? (EVENT_LABELS[e] ?? e) : "News";
}

/** Sentiment → fixed tone (positive=accent green, negative=danger red, neutral=inkFaint). */
export function sentimentTone(s: string | null): "accent" | "danger" | "inkFaint" {
  return s === "positive" ? "accent" : s === "negative" ? "danger" : "inkFaint";
}

/** ISO datetime/date → "Dec 24, 2024" (date part only). */
export function formatDateTime(iso: string | null): string {
  return iso ? formatDate(iso.slice(0, 10)) : "—";
}
