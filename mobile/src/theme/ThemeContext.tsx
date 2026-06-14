import { createContext, useContext, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import { darkTheme, lightTheme, type Theme } from "./theme";

export type Scheme = "light" | "dark";

interface ThemeValue {
  theme: Theme;
  scheme: Scheme;
}

const ThemeContext = createContext<ThemeValue>({ theme: darkTheme, scheme: "dark" });

/** Dark is the default; light is selected when the OS is in light mode. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme: Scheme = useColorScheme() === "light" ? "light" : "dark";
  const theme = scheme === "light" ? lightTheme : darkTheme;
  return <ThemeContext.Provider value={{ theme, scheme }}>{children}</ThemeContext.Provider>;
}

export const useTheme = (): Theme => useContext(ThemeContext).theme;
export const useScheme = (): Scheme => useContext(ThemeContext).scheme;
