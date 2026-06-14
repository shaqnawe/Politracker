import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * Local-only watchlist: follow members and tickers, persisted with AsyncStorage (localStorage on
 * web). Also tracks the last disclosure date "seen" per followed member so the Watchlist tab can
 * badge a member whose latest disclosure is newer than the last time you looked. No backend/account.
 */

export type WatchKind = "member" | "company";
export interface WatchItem {
  kind: WatchKind;
  id: string; // member id or ticker
  label: string;
  sub?: string;
}

const ITEMS_KEY = "politracker:watchlist";
const SEEN_KEY = "politracker:watch-seen";
const keyOf = (kind: WatchKind, id: string) => `${kind}:${id}`;

interface WatchlistValue {
  ready: boolean;
  items: WatchItem[];
  has: (kind: WatchKind, id: string) => boolean;
  toggle: (item: WatchItem) => void;
  remove: (kind: WatchKind, id: string) => void;
  /** Latest disclosure date acknowledged per member id (for the NEW badge). */
  seen: Record<string, string>;
  markSeen: (memberId: string, lastTradeDate: string | null) => void;
}

const WatchlistContext = createContext<WatchlistValue | null>(null);

export function WatchlistProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<WatchItem[]>([]);
  const [seen, setSeen] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [rawItems, rawSeen] = await AsyncStorage.multiGet([ITEMS_KEY, SEEN_KEY]);
        if (rawItems[1]) setItems(JSON.parse(rawItems[1]));
        if (rawSeen[1]) setSeen(JSON.parse(rawSeen[1]));
      } catch {
        // start empty on any read/parse error
      } finally {
        setReady(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (ready) AsyncStorage.setItem(ITEMS_KEY, JSON.stringify(items)).catch(() => {});
  }, [items, ready]);
  useEffect(() => {
    if (ready) AsyncStorage.setItem(SEEN_KEY, JSON.stringify(seen)).catch(() => {});
  }, [seen, ready]);

  const has = useCallback(
    (kind: WatchKind, id: string) => items.some((i) => i.kind === kind && i.id === id),
    [items],
  );

  const toggle = useCallback((item: WatchItem) => {
    setItems((prev) =>
      prev.some((i) => i.kind === item.kind && i.id === item.id)
        ? prev.filter((i) => !(i.kind === item.kind && i.id === item.id))
        : [...prev, item],
    );
  }, []);

  const remove = useCallback((kind: WatchKind, id: string) => {
    setItems((prev) => prev.filter((i) => !(i.kind === kind && i.id === id)));
  }, []);

  const markSeen = useCallback((memberId: string, lastTradeDate: string | null) => {
    if (!lastTradeDate) return;
    setSeen((prev) => (prev[memberId] === lastTradeDate ? prev : { ...prev, [memberId]: lastTradeDate }));
  }, []);

  const value = useMemo<WatchlistValue>(
    () => ({ ready, items, has, toggle, remove, seen, markSeen }),
    [ready, items, has, toggle, remove, seen, markSeen],
  );
  return <WatchlistContext.Provider value={value}>{children}</WatchlistContext.Provider>;
}

export function useWatchlist(): WatchlistValue {
  const ctx = useContext(WatchlistContext);
  if (!ctx) throw new Error("useWatchlist must be used within a WatchlistProvider");
  return ctx;
}

export { keyOf };
