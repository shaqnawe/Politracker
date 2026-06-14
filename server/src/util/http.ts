/**
 * Minimal HTTP client built on global fetch with:
 *  - a cookie jar (Node's fetch does not persist cookies on its own),
 *  - manual redirect following so Set-Cookie on a 3xx is captured (the Senate
 *    agreement step sets the session cookie on a 302),
 *  - polite rate limiting + light retry, since we hit government sites.
 */

const DEFAULT_UA =
  "PoliTracker/0.1 (+https://github.com/example/politracker; public STOCK Act disclosure reader)";

export interface HttpOptions {
  /** Minimum gap between requests, ms. */
  minDelayMs?: number;
  userAgent?: string;
}

export class HttpClient {
  private cookies = new Map<string, string>();
  private lastRequest = 0;
  private minDelayMs: number;
  private userAgent: string;

  constructor(opts: HttpOptions = {}) {
    this.minDelayMs = opts.minDelayMs ?? 800;
    this.userAgent = opts.userAgent ?? DEFAULT_UA;
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private storeCookies(res: Response) {
    // getSetCookie() is available on undici (Node 18+) and returns each header.
    const set = (res.headers as any).getSetCookie?.() as string[] | undefined;
    if (!set) return;
    for (const line of set) {
      const pair = line.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  getCookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  private async throttle() {
    const wait = this.lastRequest + this.minDelayMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequest = Date.now();
  }

  /** Fetch with cookie persistence and manual redirect handling. */
  async request(
    url: string,
    init: RequestInit & { maxRedirects?: number } = {},
  ): Promise<Response> {
    const maxRedirects = init.maxRedirects ?? 5;
    let current = url;
    let method = init.method ?? "GET";
    let body = init.body;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      await this.throttle();
      const headers = new Headers(init.headers);
      headers.set("User-Agent", this.userAgent);
      if (this.cookies.size) headers.set("Cookie", this.cookieHeader());
      if (!headers.has("Accept")) {
        headers.set("Accept", "text/html,application/json,*/*");
      }

      const res = await fetch(current, {
        ...init,
        method,
        body,
        headers,
        redirect: "manual",
      });
      this.storeCookies(res);

      if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
        current = new URL(res.headers.get("location")!, current).toString();
        // Per spec, redirected requests become GET (except 307/308).
        if (res.status !== 307 && res.status !== 308) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      return res;
    }
    throw new Error(`Too many redirects fetching ${url}`);
  }

  async text(url: string, init: RequestInit = {}): Promise<string> {
    const res = await this.requestWithRetry(url, init);
    return res.text();
  }

  async json<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.requestWithRetry(url, init);
    return res.json() as Promise<T>;
  }

  async buffer(url: string, init: RequestInit = {}): Promise<Buffer> {
    const res = await this.requestWithRetry(url, init);
    return Buffer.from(await res.arrayBuffer());
  }

  private async requestWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await this.request(url, init);
        if (res.status >= 500 || res.status === 429) {
          throw new Error(`HTTP ${res.status} for ${url}`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return res;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
    throw lastErr;
  }
}
