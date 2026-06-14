import { Platform } from "react-native";

/**
 * Base URL of the PoliTracker backend.
 * - iOS simulator & web reach the host machine via localhost.
 * - Android emulator reaches it via 10.0.2.2.
 * - On a physical device, set this to your computer's LAN IP, e.g. http://192.168.1.50:4000
 */
export const API_BASE =
  process.env.EXPO_PUBLIC_API_BASE ??
  (Platform.OS === "android" ? "http://10.0.2.2:4000" : "http://localhost:4000");

export type Chamber = "house" | "senate" | "executive";
export type TxType = "purchase" | "sale" | "sale_partial" | "exchange" | "other";

export interface MemberSummary {
  id: string;
  chamber: Chamber;
  fullName: string;
  state: string | null;
  district: string | null;
  party: string | null;
  tradeCount: number;
  lastTradeDate: string | null;
  /** OCR rows parked in review (provisional, unverified) — surfaced separately, flagged. */
  unverifiedCount?: number;
  /** Annual-disclosure holdings (OGE 278e) — e.g. the President, who has holdings but no PTR trades. */
  holdingsCount?: number;
}

/** A holding from an annual disclosure SNAPSHOT (OGE 278e) — a position, not a dated trade. */
export interface Holding {
  id: number;
  reportType: string;
  reportYear: number | null;
  assetName: string;
  ticker: string | null;
  assetClass: "stock" | "etf" | "fund" | "treasury" | "muni_bond" | "corp_bond" | "other";
  valueMin: number | null;
  valueMax: number | null;
  valueLabel: string;
  incomeType: string | null;
  incomeLabel: string | null;
  source: string;
  sourceUrl: string | null;
}

/** A provisional trade extracted by OCR that did NOT clear the validation/confidence gate. */
export interface ProvisionalTrade {
  id: number;
  transactionDate: string | null;
  owner: string | null;
  ticker: string | null;
  assetName: string | null;
  txType: TxType;
  amountLabel: string | null;
  confidence: number | null;
  reasons: string[];
  provider: string | null;
  filedDate: string | null;
  sourceUrl: string | null;
}

/** The fields TradeRow renders — satisfied by both a profile Trade and a feed row. */
export interface TradeRowData {
  ticker: string | null;
  assetName: string;
  txType: TxType;
  amountLabel: string;
  owner: string;
  transactionDate: string | null;
  sourceUrl: string | null;
}

export interface Trade extends TradeRowData {
  id: number;
  assetType: string | null;
  amountMin: number | null;
  amountMax: number | null;
  comment: string | null;
  filedDate: string | null;
}

/** A row in the cross-member trade feed (`/api/trades`) — carries the member it belongs to. */
export interface FeedTrade extends TradeRowData {
  id: number;
  amountMin: number | null;
  amountMax: number | null;
  memberId: string;
  memberName: string;
  chamber: Chamber;
  state: string | null;
  filedDate: string | null;
}

export interface MemberProfile {
  member: {
    id: string;
    chamber: Chamber;
    firstName: string;
    lastName: string;
    fullName: string;
    state: string | null;
    district: string | null;
    party: string | null;
    sourceUrl: string | null;
  };
  stats: {
    tradeCount: number;
    buys: number;
    sells: number;
    firstTradeDate: string | null;
    lastTradeDate: string | null;
  };
  topTickers: { ticker: string; count: number }[];
  trades: Trade[];
  /** Provisional OCR rows that didn't pass validation — shown separately, clearly flagged. */
  unverifiedTrades: ProvisionalTrade[];
  /** Annual-disclosure holdings snapshot (OGE 278e). Empty for Congress members. */
  holdings: Holding[];
}

/** A single annual financial datapoint (SEC XBRL). */
export interface FinancialDatum {
  metric: string; // revenue | net_income | eps_diluted | assets | buybacks
  fiscalYear: number;
  value: number;
  unit: string; // "USD" | "USD/shares"
  periodEnd: string | null;
}

/** An insider transaction (SEC Form 4). value = shares × price when both are present. */
export interface InsiderTrade {
  insider: string | null;
  title: string | null;
  relationship: string | null;
  txType: TxType;
  code: string | null;
  acquiredDisposed: string | null;
  date: string | null;
  shares: number | null;
  price: number | null;
  value: number | null;
  sourceUrl: string | null;
}

/** A relevant news item (free RSS), AI-summarized + tagged. */
export interface NewsItem {
  title: string;
  url: string | null;
  source: string | null;
  publishedAt: string | null;
  summary: string | null;
  eventType: string | null;
  sentiment: string | null;
}

/** Context around a traded company: financials, an AI review note, insiders, and news. */
export interface CompanyProfile {
  company: { ticker: string; cik: string | null; name: string | null };
  financials: FinancialDatum[];
  note: { body: string; flags: string[]; model: string; updatedAt: string } | null;
  insiderTrades: InsiderTrade[];
  news: NewsItem[];
}

/** Aggregate leaderboard stats. Reflects ingested (machine-readable) filings only. */
export interface Stats {
  topTickers: { ticker: string; count: number }[];
  topMembers: { id: string; fullName: string; chamber: Chamber; tradeCount: number }[];
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return (await res.json()) as T;
}

export const api = {
  listMembers: () => getJson<{ members: MemberSummary[] }>("/api/members"),
  getMember: (id: string) => getJson<MemberProfile>(`/api/members/${encodeURIComponent(id)}`),
  getCompany: (ticker: string) =>
    getJson<CompanyProfile>(`/api/companies/${encodeURIComponent(ticker)}`),
  getStats: () => getJson<Stats>("/api/stats"),
  getTrades: (params: { ticker?: string; chamber?: Chamber; limit?: number; offset?: number } = {}) => {
    const parts: string[] = [];
    if (params.ticker) parts.push(`ticker=${encodeURIComponent(params.ticker)}`);
    if (params.chamber) parts.push(`chamber=${encodeURIComponent(params.chamber)}`);
    if (params.limit != null) parts.push(`limit=${params.limit}`);
    if (params.offset != null) parts.push(`offset=${params.offset}`);
    return getJson<{ trades: FeedTrade[] }>(`/api/trades${parts.length ? `?${parts.join("&")}` : ""}`);
  },
};
