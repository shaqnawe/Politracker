import { XMLParser } from "fast-xml-parser";
import { createHash } from "node:crypto";
import { HttpClient } from "../../util/http.js";

/**
 * Free Google News RSS per query — the pragmatic, no-key news source. Returns parsed items
 * (headline + link + source + date); we never fetch or store full article text. Titles arrive as
 * "Headline - Publisher"; we keep the publisher separately and strip the suffix from the title.
 */
export interface RssItem {
  id: string; // stable hash of guid/link
  title: string;
  url: string | null;
  source: string | null;
  publishedAt: string | null; // ISO
}

const parser = new XMLParser({ ignoreAttributes: false });

/** A polite browser-ish client; Google News RSS is a public feed. */
export function newsHttp(): HttpClient {
  return new HttpClient({
    minDelayMs: 400,
    userAgent: process.env.NEWS_USER_AGENT ?? "Mozilla/5.0 (compatible; PoliTracker/0.1)",
  });
}

const text = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && "#text" in (v as any)) return String((v as any)["#text"]);
  return String(v);
};

const toIso = (pubDate: unknown): string | null => {
  const s = text(pubDate);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

export async function googleNewsRss(http: HttpClient, query: string): Promise<RssItem[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const xml = await http.text(url);
  const raw = parser.parse(xml)?.rss?.channel?.item;
  const items = (Array.isArray(raw) ? raw : raw ? [raw] : []) as any[];

  return items.map((it) => {
    const source = text(it.source);
    let title = text(it.title) ?? "";
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    const link = text(it.link);
    const guid = text(it.guid) ?? link ?? title;
    return {
      id: createHash("sha1").update(guid).digest("hex").slice(0, 16),
      title,
      url: link,
      source,
      publishedAt: toIso(it.pubDate),
    };
  });
}
