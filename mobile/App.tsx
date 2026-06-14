import { ActivityIndicator, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import {
  NavigationContainer,
  DefaultTheme,
  DarkTheme,
  type LinkingOptions,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import {
  useFonts,
  Newsreader_400Regular,
  Newsreader_600SemiBold,
} from "@expo-google-fonts/newsreader";
import {
  SplineSans_400Regular,
  SplineSans_500Medium,
  SplineSans_600SemiBold,
} from "@expo-google-fonts/spline-sans";
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
} from "@expo-google-fonts/jetbrains-mono";
import type { RootStackParamList, TabParamList } from "./src/navigation";
import MembersScreen from "./src/screens/MembersScreen";
import MemberScreen from "./src/screens/MemberScreen";
import CompanyScreen from "./src/screens/CompanyScreen";
import ExploreScreen from "./src/screens/ExploreScreen";
import FeedScreen from "./src/screens/FeedScreen";
import WatchlistScreen from "./src/screens/WatchlistScreen";
import HeaderBrand from "./src/components/HeaderBrand";
import WatchButton from "./src/components/WatchButton";
import { fonts, ThemeProvider, useScheme, useTheme } from "./src/theme";
import { WatchlistProvider } from "./src/watchlist";

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

const linking: LinkingOptions<RootStackParamList> = {
  prefixes: [],
  config: {
    screens: {
      Tabs: { screens: { MembersTab: "", Feed: "feed", Explore: "explore", Watchlist: "watchlist" } },
      Member: "member/:id",
      Company: "company/:ticker",
    },
  },
};

/** Bottom tabs. Each screen paints its own `bg`; Member/Company are pushed on the root stack. */
function Tabs() {
  const t = useTheme();
  return (
    <Tab.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: t.bg },
        headerTintColor: t.ink,
        headerTitleStyle: { fontFamily: fonts.head, fontSize: 18 },
        headerShadowVisible: false,
        tabBarActiveTintColor: t.accent3,
        tabBarInactiveTintColor: t.inkFaint,
        tabBarStyle: { backgroundColor: t.bg, borderTopColor: t.border },
        tabBarLabelStyle: { fontFamily: fonts.uiMedium, fontSize: 11 },
      }}
    >
      <Tab.Screen
        name="MembersTab"
        component={MembersScreen}
        options={{
          title: "Members",
          headerTitle: () => <HeaderBrand />,
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 17 }}>≡</Text>,
        }}
      />
      <Tab.Screen
        name="Feed"
        component={FeedScreen}
        options={{ title: "Feed", tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 16 }}>◷</Text> }}
      />
      <Tab.Screen
        name="Explore"
        component={ExploreScreen}
        options={{ title: "Explore", tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 16 }}>◎</Text> }}
      />
      <Tab.Screen
        name="Watchlist"
        component={WatchlistScreen}
        options={{ title: "Watchlist", tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 16 }}>★</Text> }}
      />
    </Tab.Navigator>
  );
}

function Root() {
  const t = useTheme();
  const scheme = useScheme();

  const [fontsLoaded] = useFonts({
    Newsreader_400Regular,
    Newsreader_600SemiBold,
    SplineSans_400Regular,
    SplineSans_500Medium,
    SplineSans_600SemiBold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  });

  if (!fontsLoaded) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.bg }}>
        <ActivityIndicator color={t.accent3} size="large" />
      </View>
    );
  }

  const base = scheme === "dark" ? DarkTheme : DefaultTheme;
  const navTheme = {
    ...base,
    colors: {
      ...base.colors,
      background: t.bg,
      card: t.bg,
      text: t.ink,
      border: t.border,
      primary: t.accent3,
      notification: t.danger,
    },
  };

  return (
    <NavigationContainer theme={navTheme} linking={linking}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: t.bg },
          headerTintColor: t.ink,
          headerTitleStyle: { fontFamily: fonts.head, fontSize: 18 },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: t.bg },
        }}
      >
        <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
        <Stack.Screen
          name="Member"
          component={MemberScreen}
          options={({ route }) => ({
            title: route.params.name ?? "Member",
            headerRight: () => (
              <WatchButton item={{ kind: "member", id: route.params.id, label: route.params.name ?? route.params.id }} />
            ),
          })}
        />
        <Stack.Screen
          name="Company"
          component={CompanyScreen}
          options={({ route }) => ({
            title: route.params.ticker,
            headerRight: () => <WatchButton item={{ kind: "company", id: route.params.ticker, label: route.params.ticker }} />,
          })}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <WatchlistProvider>
        <Root />
      </WatchlistProvider>
    </ThemeProvider>
  );
}
