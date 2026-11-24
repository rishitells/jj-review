import { registerCustomTheme } from "@pierre/diffs";

// Themes that don't ship with Pierre, copied from Zed extensions with their licences (see each folder) and registered
// under these names. A Nightfox file holds the whole family; its loader picks the member.
const fromFamily = (load, name) => () => load().then((m) => m.default.themes.find((t) => t.name === name));
registerCustomTheme("jetbrains-light", () => import("./jetbrains/jetbrains-light.json"), "zed");
registerCustomTheme("jetbrains-dark", () => import("./jetbrains/jetbrains-dark.json"), "zed");
registerCustomTheme("jetbrains-islands-light", () => import("./jetbrains/jetbrains-islands-light.json"), "zed");
registerCustomTheme("jetbrains-islands-dark", () => import("./jetbrains/jetbrains-islands-dark.json"), "zed");
const nightfox = () => import("./nightfox/nightfox.json");
for (const [id, name] of [
  ["dayfox", "Dayfox - opaque"],
  ["dawnfox", "Dawnfox - opaque"],
  ["nightfox", "Nightfox - opaque"],
  ["duskfox", "Duskfox - opaque"],
  ["nordfox", "Nordfox - opaque"],
]) {
  registerCustomTheme(id, fromFamily(nightfox, name), "zed");
}

// The diff themes, as light and dark pairs: the page follows the chosen mode and takes the theme's background (Pierre
// keeps the page's own). Each side's colours draw its preview in the picker; they are the background, text, keyword,
// string and function colours of that theme in @pierre/highlights or in its file here.
export const THEME_GROUPS = [
  { name: "Default", themes: [
    { id: "pierre", name: "Pierre",
      light: { theme: "pierre-light", bg: "#ffffff", fg: "#0a0a0a", kw: "#d32a61", str: "#199f43", fn: "#693acf" },
      dark: { theme: "pierre-dark", bg: "#0a0a0a", fg: "#fafafa", kw: "#ff678d", str: "#5ecc71", fn: "#9d6afb" } },
    { id: "pierre-soft", name: "Pierre Soft",
      light: { theme: "pierre-light-soft", bg: "#ffffff", fg: "#525252", kw: "#ff678d", str: "#0dbe4e", fn: "#9d6afb" },
      dark: { theme: "pierre-dark-soft", bg: "#171717", fg: "#d4d4d4", kw: "#ff91a8", str: "#8cda94", fn: "#ba8ffd" } },
    { id: "pierre-pd", name: "Pierre, red–green safe",
      light: { theme: "pierre-light-protanopia-deuteranopia", bg: "#ffffff", fg: "#0a0a0a", kw: "#8836c7", str: "#215584", fn: "#5731a7" },
      dark: { theme: "pierre-dark-protanopia-deuteranopia", bg: "#0a0a0a", fg: "#fafafa", kw: "#b969f3", str: "#97c4ff", fn: "#ba8ffd" } },
    { id: "pierre-t", name: "Pierre, blue–yellow safe",
      light: { theme: "pierre-light-tritanopia", bg: "#ffffff", fg: "#0a0a0a", kw: "#a631be", str: "#1e858e", fn: "#216cab" },
      dark: { theme: "pierre-dark-tritanopia", bg: "#0a0a0a", fg: "#fafafa", kw: "#d568ea", str: "#92dde4", fn: "#97c4ff" } },
  ] },
  { name: "Warm", themes: [
    { id: "gruvbox-soft", name: "Gruvbox Soft",
      light: { theme: "gruvbox-light-soft", bg: "#f2e5bc", fg: "#282828", kw: "#9d0006", str: "#79740e", fn: "#79740e" },
      dark: { theme: "gruvbox-dark-soft", bg: "#32302f", fg: "#ebdbb2", kw: "#fb4833", str: "#b8bb25", fn: "#b8bb25" } },
    { id: "gruvbox", name: "Gruvbox",
      light: { theme: "gruvbox-light-medium", bg: "#fbf1c7", fg: "#282828", kw: "#9d0006", str: "#79740e", fn: "#79740e" },
      dark: { theme: "gruvbox-dark-medium", bg: "#282828", fg: "#ebdbb2", kw: "#fb4833", str: "#b8bb25", fn: "#b8bb25" } },
    { id: "gruvbox-hard", name: "Gruvbox Hard",
      light: { theme: "gruvbox-light-hard", bg: "#f9f5d7", fg: "#282828", kw: "#9d0006", str: "#79740e", fn: "#79740e" },
      dark: { theme: "gruvbox-dark-hard", bg: "#1d2021", fg: "#ebdbb2", kw: "#fb4833", str: "#b8bb25", fn: "#b8bb25" } },
    { id: "rose-pine", name: "Rosé Pine",
      light: { theme: "rose-pine-dawn", bg: "#faf4ed", fg: "#575279", kw: "#286983", str: "#ea9d34", fn: "#d7827e" },
      dark: { theme: "rose-pine-moon", bg: "#232136", fg: "#e0def4", kw: "#3e8fb0", str: "#f6c177", fn: "#ea9a97" } },
    { id: "dawnfox", name: "Dawnfox",
      light: { theme: "dawnfox", bg: "#faf4ed", fg: "#575279", kw: "#907aa9", str: "#618774", fn: "#295e73" },
      dark: { theme: "duskfox", bg: "#232136", fg: "#e0def4", kw: "#c4a7e7", str: "#a3be8c", fn: "#65b1cd" } },
    { id: "everforest", name: "Everforest",
      light: { theme: "everforest-light", bg: "#fdf6e3", fg: "#5c6a72", kw: "#f85552", str: "#35a77c", fn: "#8da101" },
      dark: { theme: "everforest-dark", bg: "#2d353b", fg: "#d3c6aa", kw: "#e67e80", str: "#83c092", fn: "#a7c080" } },
    { id: "kanagawa", name: "Kanagawa",
      light: { theme: "kanagawa-lotus", bg: "#f2ecbc", fg: "#545464", kw: "#766b90", str: "#6f894e", fn: "#4d699b" },
      dark: { theme: "kanagawa-wave", bg: "#1f1f28", fg: "#dcd7ba", kw: "#957fb8", str: "#98bb6c", fn: "#7e9cd8" } },
    { id: "solarized", name: "Solarized",
      light: { theme: "solarized-light", bg: "#fdf6e3", fg: "#657b83", kw: "#859900", str: "#2aa198", fn: "#268bd2" },
      dark: { theme: "solarized-dark", bg: "#002b36", fg: "#839496", kw: "#859900", str: "#2aa198", fn: "#268bd2" } },
    { id: "horizon", name: "Horizon",
      light: { theme: "horizon-bright", bg: "#fdf0ed", fg: "#06060c", kw: "#8a31b9", str: "#f6661e", fn: "#1d8991" },
      dark: { theme: "horizon", bg: "#1c1e26", fg: "#d5d8da", kw: "#b877db", str: "#fab795", fn: "#25b0bc" } },
  ] },
  { name: "Cool and neutral", themes: [
    { id: "github", name: "GitHub",
      light: { theme: "github-light-default", bg: "#ffffff", fg: "#1f2328", kw: "#cf222e", str: "#0a3069", fn: "#8250df" },
      dark: { theme: "github-dark-default", bg: "#0d1117", fg: "#e6edf3", kw: "#ff7b72", str: "#a5d6ff", fn: "#d2a8ff" } },
    { id: "github-dimmed", name: "GitHub Dimmed",
      light: { theme: "github-light", bg: "#ffffff", fg: "#24292e", kw: "#d73a49", str: "#032f62", fn: "#6f42c1" },
      dark: { theme: "github-dark-dimmed", bg: "#212830", fg: "#d1d7e0", kw: "#f47067", str: "#96d0ff", fn: "#dcbdfb" } },
    { id: "github-hc", name: "GitHub High Contrast",
      light: { theme: "github-light-high-contrast", bg: "#ffffff", fg: "#010409", kw: "#a0111f", str: "#032563", fn: "#622cbc" },
      dark: { theme: "github-dark-high-contrast", bg: "#010409", fg: "#ffffff", kw: "#ff9492", str: "#addcff", fn: "#dbb7ff" } },
    { id: "vscode", name: "VS Code",
      light: { theme: "light-plus", bg: "#ffffff", fg: "#000000", kw: "#0000ff", str: "#a31515", fn: "#795e26" },
      dark: { theme: "dark-plus", bg: "#1e1e1e", fg: "#d4d4d4", kw: "#569cd6", str: "#ce9178", fn: "#dcdcaa" } },
    { id: "jetbrains", name: "JetBrains",
      light: { theme: "jetbrains-light", bg: "#ffffff", fg: "#080808", kw: "#0033b3", str: "#067d17", fn: "#00627a" },
      dark: { theme: "jetbrains-dark", bg: "#1e1f22", fg: "#bcbec4", kw: "#cf8e6d", str: "#6aab73", fn: "#6aa2d7" } },
    { id: "jetbrains-islands", name: "JetBrains Islands",
      light: { theme: "jetbrains-islands-light", bg: "#ffffff", fg: "#080808", kw: "#0033b3", str: "#067d17", fn: "#00627a" },
      dark: { theme: "jetbrains-islands-dark", bg: "#191a1c", fg: "#bcbec4", kw: "#cf8e6d", str: "#6aab73", fn: "#56a8f5" } },
    { id: "one", name: "One",
      light: { theme: "one-light", bg: "#fafafa", fg: "#383a42", kw: "#a626a4", str: "#50a14f", fn: "#4078f2" },
      dark: { theme: "one-dark-pro", bg: "#23272e", fg: "#abb2bf", kw: "#c678dd", str: "#98c379", fn: "#61afef" } },
    { id: "vitesse", name: "Vitesse",
      light: { theme: "vitesse-light", bg: "#ffffff", fg: "#393a34", kw: "#ab5959", str: "#b56959", fn: "#59873a" },
      dark: { theme: "vitesse-dark", bg: "#121212", fg: "#dbd7ca", kw: "#cb7676", str: "#c98a7d", fn: "#80a665" } },
    { id: "catppuccin", name: "Catppuccin",
      light: { theme: "catppuccin-latte", bg: "#eff1f5", fg: "#4c4f69", kw: "#8839ef", str: "#40a02b", fn: "#1e66f5" },
      dark: { theme: "catppuccin-mocha", bg: "#1e1e2e", fg: "#cdd6f4", kw: "#cba6f7", str: "#a6e3a1", fn: "#89b4fa" } },
    { id: "ayu", name: "Ayu",
      light: { theme: "ayu-light", bg: "#fcfcfc", fg: "#5c6166", kw: "#fa8d3e", str: "#86b300", fn: "#f2ad48" },
      dark: { theme: "ayu-mirage", bg: "#242835", fg: "#cccac2", kw: "#ffad65", str: "#d4fe7f", fn: "#ffd173" } },
    { id: "material", name: "Material",
      light: { theme: "material-theme-lighter", bg: "#fafafa", fg: "#90a4ae", kw: "#39adb5", str: "#91b859", fn: "#6182b8" },
      dark: { theme: "material-theme-palenight", bg: "#292d3e", fg: "#babed8", kw: "#89ddff", str: "#c3e88d", fn: "#82aaff" } },
    { id: "min", name: "Min",
      light: { theme: "min-light", bg: "#ffffff", fg: "#212121", kw: "#d32f2f", str: "#22863a", fn: "#6f42c1" },
      dark: { theme: "min-dark", bg: "#1a1a1a", fg: "#bbbbbb", kw: "#fa7584", str: "#ffab70", fn: "#b392f1" } },
    { id: "night-owl", name: "Night Owl",
      light: { theme: "night-owl-light", bg: "#fbfbfb", fg: "#403f53", kw: "#994cc3", str: "#c96765", fn: "#4876d6" },
      dark: { theme: "night-owl", bg: "#011627", fg: "#d6deeb", kw: "#c792ea", str: "#ecc48d", fn: "#82aaff" } },
    { id: "nightfox", name: "Nightfox",
      light: { theme: "dayfox", bg: "#f6f2ee", fg: "#3d2b5a", kw: "#6e33ce", str: "#396847", fn: "#223d90" },
      dark: { theme: "nightfox", bg: "#192330", fg: "#cdcecf", kw: "#9d79d6", str: "#81b29a", fn: "#86abdc" } },
    { id: "nordfox", name: "Nordfox",
      light: { theme: "dayfox", bg: "#f6f2ee", fg: "#3d2b5a", kw: "#6e33ce", str: "#396847", fn: "#223d90" },
      dark: { theme: "nordfox", bg: "#2e3440", fg: "#cdcecf", kw: "#b48ead", str: "#a3be8c", fn: "#8cafd2" } },
    { id: "slack", name: "Slack",
      light: { theme: "slack-ochin", bg: "#ffffff", fg: "#000000", kw: "#7b30d0", str: "#a44185", fn: "#7eb233" },
      dark: { theme: "slack-dark", bg: "#222222", fg: "#e6e6e6", kw: "#569cd6", str: "#ce9178", fn: "#dcdcaa" } },
  ] },
];
export const THEMES = THEME_GROUPS.flatMap((g) => g.themes);
export const themeOf = (id) => THEMES.find((t) => t.id === id) ?? THEMES[0];
