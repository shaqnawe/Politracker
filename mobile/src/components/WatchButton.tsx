import { Pressable, Text } from "react-native";
import { useTheme } from "../theme";
import { useWatchlist, type WatchItem } from "../watchlist";

/** Header ★ toggle to follow/unfollow a member or ticker. */
export default function WatchButton({ item }: { item: WatchItem }) {
  const t = useTheme();
  const { has, toggle } = useWatchlist();
  const followed = has(item.kind, item.id);
  return (
    <Pressable
      onPress={() => toggle(item)}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={followed ? `Unfollow ${item.label}` : `Follow ${item.label}`}
    >
      <Text style={{ color: followed ? t.accent2 : t.inkFaint, fontSize: 20 }}>{followed ? "★" : "☆"}</Text>
    </Pressable>
  );
}
