import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { api, type Chamber, type FeedTrade } from "../api";
import Caveats from "../components/Caveats";
import TradeRow from "../components/TradeRow";
import type { TabScreenProps } from "../navigation";
import { fonts, radius, tint, useTheme } from "../theme";

type Props = TabScreenProps<"Feed">;
type Filter = "all" | Extract<Chamber, "senate" | "house">;
const PAGE = 25;

export default function FeedScreen({ navigation }: Props) {
  const t = useTheme();
  const [trades, setTrades] = useState<FeedTrade[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const load = useCallback(
    async (reset: boolean) => {
      if (busy.current) return;
      busy.current = true;
      try {
        setError(null);
        const offset = reset ? 0 : trades.length;
        const { trades: page } = await api.getTrades({
          chamber: filter === "all" ? undefined : filter,
          limit: PAGE,
          offset,
        });
        setHasMore(page.length === PAGE);
        setTrades((prev) => (reset ? page : [...prev, ...page]));
      } catch (e) {
        setError((e as Error).message || "Could not reach the server");
      } finally {
        busy.current = false;
        setLoading(false);
        setLoadingMore(false);
        setRefreshing(false);
      }
    },
    [filter, trades.length],
  );

  // (Re)load from the top whenever the chamber filter changes.
  useEffect(() => {
    setLoading(true);
    setTrades([]);
    setHasMore(true);
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: t.bg }]}>
        <ActivityIndicator color={t.accent3} size="large" />
      </View>
    );
  }

  return (
    <View style={[styles.fill, { backgroundColor: t.bg }]}>
      <View style={styles.filters}>
        {(["all", "senate", "house"] as Filter[]).map((f) => {
          const active = filter === f;
          return (
            <Pressable
              key={f}
              onPress={() => setFilter(f)}
              style={[styles.chip, { backgroundColor: active ? t.accent3 : t.panel, borderColor: active ? t.accent3 : t.border }]}
            >
              <Text style={[styles.chipText, { color: active ? "#fff" : t.inkSoft, fontFamily: fonts.uiMedium }]}>
                {f === "all" ? "All" : f === "senate" ? "Senate" : "House"}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {error && trades.length === 0 ? (
        <View style={styles.center}>
          <Text style={[styles.error, { color: t.danger, fontFamily: fonts.ui }]}>{error}</Text>
          <Pressable onPress={() => load(true)} style={[styles.retry, { backgroundColor: t.accent3 }]}>
            <Text style={{ color: "#fff", fontFamily: fonts.uiSemiBold }}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={trades}
          keyExtractor={(tr) => String(tr.id)}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} tintColor={t.accent3} />
          }
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (hasMore && !busy.current) {
              setLoadingMore(true);
              load(false);
            }
          }}
          renderItem={({ item }) => (
            <Pressable onPress={() => navigation.navigate("Member", { id: item.memberId, name: item.memberName })}>
              <TradeRow trade={item} memberName={item.memberName} />
            </Pressable>
          )}
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator color={t.accent3} style={{ marginVertical: 16 }} />
            ) : !hasMore ? (
              <Caveats feed />
            ) : null
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  filters: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  chip: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1 },
  chipText: { fontSize: 13 },
  list: { paddingHorizontal: 16, paddingTop: 2, paddingBottom: 28 },
  error: { textAlign: "center", fontSize: 15 },
  retry: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 },
});
