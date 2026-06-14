import type { CompositeScreenProps, NavigatorScreenParams } from "@react-navigation/native";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

/** Bottom tabs. Member/Company detail screens live on the root stack (shared by every tab). */
export type TabParamList = {
  MembersTab: undefined;
  Feed: undefined;
  Explore: undefined;
  Watchlist: undefined;
};

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  Member: { id: string; name?: string };
  Company: { ticker: string };
};

/** Props for a tab screen that can also push the shared Member/Company detail screens. */
export type TabScreenProps<T extends keyof TabParamList> = CompositeScreenProps<
  BottomTabScreenProps<TabParamList, T>,
  NativeStackScreenProps<RootStackParamList>
>;
