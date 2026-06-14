import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { api, type MemberSummary } from "../api";
import { chamberLabel, formatDate, memberLocation } from "../format";
import type { TabScreenProps } from "../navigation";
import { cardShadow, fonts, numeric, radius, space, tint, useScheme, useTheme } from "../theme";
import { useWatchlist } from "../watchlist";

type Props = TabScreenProps<"Watchlist">;

export default function WatchlistScreen({ navigation }: Props) {
  const t = useTheme();
  const scheme = useScheme();
  const { items, seen, remove, markSeen } = useWatchlist();
  const [byId, setById] = useState<Record<string, MemberSummary>>({});
  const [refreshing, setRefreshing] = useState(false);

  const members = items.filter((i) => i.kind === "member");
  const companies = items.filter((i) => i.kind === "company");

  async function load() {
    try {
      const { members: all } = await api.listMembers();
      setById(Object.fromEntries(all.map((m) => [m.id, m])));
    } catch {
      // leave byId as-is; rows still render from stored labels
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
    return navigation.addListener("focus", load);
  }, [navigation]);

  // Baseline the "seen" date the first time a followed member is observed, so it isn't falsely NEW.
  useEffect(() => {
    for (const m of members) {
      const d = byId[m.id]?.lastTradeDate;
      if (d && !seen[m.id]) markSeen(m.id, d);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byId, items]);

  const isNew = (id: string) => {
    const d = byId[id]?.lastTradeDate;
    return !!d && !!seen[id] && d > seen[id];
  };

  const openMember = (id: string, name: string) => {
    markSeen(id, byId[id]?.lastTradeDate ?? null);
    navigation.navigate("Member", { id, name });
  };

  const empty = items.length === 0;

  return (
    <ScrollView
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={empty ? styles.emptyWrap : styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={t.accent3} />
      }
    >
      {empty ? (
        <Text style={[styles.empty, { color: t.inkFaint, fontFamily: fonts.ui }]}>
          You're not following anyone yet.{"\n"}Tap ★ on a member or company to add them here.
        </Text>
      ) : (
        <>
          {members.length > 0 && (
            <>
              <Text style={[styles.section, { color: t.ink, fontFamily: fonts.head }]}>Members</Text>
              <View style={styles.group}>
                {members.map((m) => {
                  const sum = byId[m.id];
                  const name = sum?.fullName ?? m.label; // prefer the live name (handles deep-link follows)
                  return (
                    <Pressable
                      key={m.id}
                      onPress={() => openMember(m.id, name)}
                      style={({ pressed }) => [styles.row, cardShadow(scheme), { backgroundColor: pressed ? t.panel2 : t.panel, borderColor: t.border }]}
                    >
                      <View style={styles.rowMain}>
                        <View style={styles.nameLine}>
                          <Text style={[styles.name, { color: t.ink, fontFamily: fonts.uiSemiBold }]} numberOfLines={1}>
                            {name}
                          </Text>
                          {isNew(m.id) && (
                            <View style={[styles.newBadge, { backgroundColor: tint(t.accent) }]}>
                              <Text style={[styles.newText, { color: t.accent, fontFamily: fonts.uiSemiBold }]}>NEW</Text>
                            </View>
                          )}
                        </View>
                        <Text style={[styles.sub, { color: t.inkSoft, fontFamily: fonts.ui }]} numberOfLines={1}>
                          {sum ? memberLocation(sum.chamber, sum.state, sum.district) : chamberLabel("house")}
                          {sum?.lastTradeDate ? `  ·  last ${formatDate(sum.lastTradeDate)}` : ""}
                        </Text>
                      </View>
                      <Pressable hitSlop={10} onPress={() => remove("member", m.id)} accessibilityLabel={`Unfollow ${m.label}`}>
                        <Text style={[styles.remove, { color: t.inkFaint }]}>✕</Text>
                      </Pressable>
                    </Pressable>
                  );
                })}
              </View>
            </>
          )}

          {companies.length > 0 && (
            <>
              <Text style={[styles.section, { color: t.ink, fontFamily: fonts.head }]}>Companies</Text>
              <View style={styles.group}>
                {companies.map((c) => (
                  <Pressable
                    key={c.id}
                    onPress={() => navigation.navigate("Company", { ticker: c.id })}
                    style={({ pressed }) => [styles.row, cardShadow(scheme), { backgroundColor: pressed ? t.panel2 : t.panel, borderColor: t.border }]}
                  >
                    <View style={styles.rowMain}>
                      <Text style={[styles.ticker, numeric, { color: t.accent3 }]}>{c.label}</Text>
                    </View>
                    <Pressable hitSlop={10} onPress={() => remove("company", c.id)} accessibilityLabel={`Unfollow ${c.label}`}>
                      <Text style={[styles.remove, { color: t.inkFaint }]}>✕</Text>
                    </Pressable>
                  </Pressable>
                ))}
              </View>
            </>
          )}

          <Text style={[styles.hint, { color: t.inkFaint, fontFamily: fonts.ui }]}>
            NEW marks a followed member with a disclosure newer than your last visit. Subject to the
            ~45-day reporting lag.
          </Text>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: space.xxl },
  emptyWrap: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: space.xxl },
  empty: { textAlign: "center", fontSize: 15, lineHeight: 22 },
  section: { fontSize: 18, marginTop: space.md, marginBottom: space.sm },
  group: { gap: space.sm + 2 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.card,
    borderWidth: 1,
    paddingHorizontal: space.lg,
    paddingVertical: 13,
    gap: space.md,
  },
  rowMain: { flex: 1, minWidth: 0 },
  nameLine: { flexDirection: "row", alignItems: "center", gap: space.sm },
  name: { fontSize: 15.5, flexShrink: 1 },
  sub: { fontSize: 13, marginTop: 3 },
  ticker: { fontSize: 16, fontWeight: "600" },
  newBadge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.chip },
  newText: { fontSize: 9.5, letterSpacing: 0.7 },
  remove: { fontSize: 16, paddingHorizontal: 2 },
  hint: { fontSize: 12, marginTop: space.lg, lineHeight: 17 },
});
