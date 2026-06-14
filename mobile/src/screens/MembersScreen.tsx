import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { api, type Chamber, type MemberSummary } from "../api";
import Caveats from "../components/Caveats";
import { chamberLabel, formatDate, memberLocation } from "../format";
import type { TabScreenProps } from "../navigation";
import { cardShadow, fonts, numeric, radius, tint, useScheme, useTheme } from "../theme";

type Props = TabScreenProps<"MembersTab">;
type Filter = "all" | Chamber;

export default function MembersScreen({ navigation }: Props) {
  const t = useTheme();
  const scheme = useScheme();
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  async function load() {
    try {
      setError(null);
      const data = await api.listMembers();
      setMembers(data.members);
    } catch (e) {
      setError((e as Error).message || "Could not reach the server");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return members.filter(
      (m) =>
        (filter === "all" || m.chamber === filter) &&
        (!q || m.fullName.toLowerCase().includes(q) || (m.state ?? "").toLowerCase().includes(q)),
    );
  }, [members, query, filter]);

  if (loading) {
    return (
      <View style={[styles.container, styles.center, { backgroundColor: t.bg }]}>
        <ActivityIndicator color={t.accent3} size="large" />
        <Text style={[styles.dim, { color: t.inkFaint, fontFamily: fonts.ui }]}>Loading members…</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: t.bg }]}>
      <TextInput
        style={[
          styles.search,
          { backgroundColor: t.panel, color: t.ink, borderColor: t.border, fontFamily: fonts.ui },
        ]}
        placeholder="Search by name or state"
        placeholderTextColor={t.inkFaint}
        value={query}
        onChangeText={setQuery}
        autoCorrect={false}
      />
      <View style={styles.filters}>
        {(["all", "senate", "house"] as Filter[]).map((f) => {
          const active = filter === f;
          return (
            <Pressable
              key={f}
              onPress={() => setFilter(f)}
              style={[
                styles.chip,
                { backgroundColor: active ? t.accent3 : t.panel, borderColor: active ? t.accent3 : t.border },
              ]}
            >
              <Text style={[styles.chipText, { color: active ? "#fff" : t.inkSoft, fontFamily: fonts.uiMedium }]}>
                {f === "all" ? "All" : f === "senate" ? "Senate" : "House"}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {error ? (
        <View style={styles.center}>
          <Text style={[styles.error, { color: t.danger, fontFamily: fonts.ui }]}>{error}</Text>
          <Pressable onPress={load} style={[styles.retry, { backgroundColor: t.accent3 }]}>
            <Text style={{ color: "#fff", fontFamily: fonts.uiSemiBold }}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load();
              }}
              tintColor={t.accent3}
            />
          }
          ListEmptyComponent={
            <Text style={[styles.dim, styles.empty, { color: t.inkFaint, fontFamily: fonts.ui }]}>
              No members match.
            </Text>
          }
          ListFooterComponent={filtered.length > 0 ? <Caveats ranking /> : null}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [
                styles.row,
                cardShadow(scheme),
                { backgroundColor: pressed ? t.panel2 : t.panel, borderColor: t.border },
              ]}
              onPress={() => navigation.navigate("Member", { id: item.id, name: item.fullName })}
            >
              <View style={styles.rowMain}>
                <View style={styles.nameRow}>
                  <View style={[styles.badge, { backgroundColor: tint(t.accent3) }]}>
                    <Text style={[styles.badgeText, { color: t.accent3, fontFamily: fonts.uiSemiBold }]}>
                      {chamberLabel(item.chamber)}
                    </Text>
                  </View>
                </View>
                <Text style={[styles.name, { color: t.ink, fontFamily: fonts.uiSemiBold }]} numberOfLines={1}>
                  {item.fullName}
                </Text>
                <Text style={[styles.sub, { color: t.inkSoft, fontFamily: fonts.ui }]} numberOfLines={1}>
                  {memberLocation(item.chamber, item.state, item.district)}
                  {item.lastTradeDate ? `  ·  last ${formatDate(item.lastTradeDate)}` : ""}
                </Text>
              </View>
              <View style={styles.rowRight}>
                <View style={styles.countCol}>
                  {item.tradeCount > 0 ? (
                    <>
                      <Text style={[styles.count, numeric, { color: t.ink }]}>{item.tradeCount}</Text>
                      <Text style={[styles.countLabel, { color: t.inkFaint, fontFamily: fonts.ui }]}>trades</Text>
                    </>
                  ) : (item.unverifiedCount ?? 0) > 0 ? (
                    <>
                      <Text style={[styles.count, numeric, { color: t.accent2 }]}>{item.unverifiedCount ?? 0}</Text>
                      <Text style={[styles.countLabel, { color: t.inkFaint, fontFamily: fonts.ui }]}>unverified</Text>
                    </>
                  ) : (
                    <>
                      <Text style={[styles.count, numeric, { color: t.accent3 }]}>{item.holdingsCount ?? 0}</Text>
                      <Text style={[styles.countLabel, { color: t.inkFaint, fontFamily: fonts.ui }]}>holdings</Text>
                    </>
                  )}
                </View>
                <Text style={[styles.chevron, { color: t.inkFaint }]}>›</Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  dim: {},
  empty: { textAlign: "center", marginTop: 40 },
  search: {
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: radius.card,
    borderWidth: 1,
    fontSize: 15,
  },
  filters: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  chip: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1 },
  chipText: { fontSize: 13 },
  list: { paddingHorizontal: 16, paddingTop: 2, paddingBottom: 32 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.card,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
  },
  rowMain: { flex: 1, minWidth: 0, paddingRight: 12 },
  nameRow: { flexDirection: "row", marginBottom: 7 },
  name: { fontSize: 16.5 },
  sub: { fontSize: 13, marginTop: 3 },
  rowRight: { flexDirection: "row", alignItems: "center", gap: 4 },
  countCol: { alignItems: "flex-end" },
  badge: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: radius.chip, alignSelf: "flex-start" },
  badgeText: { fontSize: 10, letterSpacing: 0.6 },
  count: { fontSize: 20, fontWeight: "700" },
  countLabel: { fontSize: 11 },
  chevron: { fontSize: 22, marginLeft: 2 },
  error: { textAlign: "center", fontSize: 15 },
  retry: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 },
});
