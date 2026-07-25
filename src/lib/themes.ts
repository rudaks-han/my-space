/**
 * 앱 디자인 프리셋(테마) 모음.
 *
 * 각 프리셋은 유명 앱의 색감을 흉내 낸 CSS 변수 세트를 라이트/다크 모드별로 정의한다.
 * 선택된 프리셋은 theme-preset-provider 가 `<style>` 로 문서에 주입하며, index.css 의
 * 기본값(:root / .dark)을 덮어쓴다. 라이트/다크 전환(theme-provider)과는 독립적이다.
 *
 * ★ 프리셋 추가 지점 ★ — 아래 PRESETS 배열에 makeVars 로 만든 항목을 추가하면
 * 설정 화면(Theme 카테고리)에 자동으로 스와치가 나타난다.
 */

/** makeVars 입력 스펙(짧은 키). 없으면 합리적인 기본값으로 채운다. */
interface ModeSpec {
  bg: string
  fg: string
  card?: string
  cardFg?: string
  popover?: string
  primary: string
  primaryFg: string
  secondary?: string
  secondaryFg?: string
  muted: string
  mutedFg: string
  accent?: string
  accentFg?: string
  destructive?: string
  border: string
  input?: string
  ring?: string
  sidebar: string
  sidebarFg: string
  sidebarPrimary?: string
  sidebarPrimaryFg?: string
  sidebarAccent: string
  sidebarAccentFg?: string
  sidebarBorder?: string
  sidebarRing?: string
}

export type ThemeVars = Record<string, string>

export interface ThemePreset {
  /** 저장 키로 쓰는 고유 id */
  id: string
  /** 설정 화면에 표시할 이름 */
  label: string
  /** 한 줄 설명 */
  description: string
  /**
   * 원본에 한쪽 모드만 있는 테마(예: Darcula)라면 여기에 그 모드를 적는다.
   * 이 프리셋이 켜져 있는 동안 라이트/다크 토글은 무효가 되고 해당 모드로 고정된다.
   */
  forcedMode?: "light" | "dark"
  light: ThemeVars
  dark: ThemeVars
}

/** 짧은 스펙 + 반경을 전체 CSS 변수 맵으로 확장한다. */
function makeVars(radius: string, s: ModeSpec): ThemeVars {
  const card = s.card ?? s.bg
  return {
    "--background": s.bg,
    "--foreground": s.fg,
    "--card": card,
    "--card-foreground": s.cardFg ?? s.fg,
    "--popover": s.popover ?? card,
    "--popover-foreground": s.cardFg ?? s.fg,
    "--primary": s.primary,
    "--primary-foreground": s.primaryFg,
    "--secondary": s.secondary ?? s.muted,
    "--secondary-foreground": s.secondaryFg ?? s.fg,
    "--muted": s.muted,
    "--muted-foreground": s.mutedFg,
    "--accent": s.accent ?? s.muted,
    "--accent-foreground": s.accentFg ?? s.fg,
    "--destructive": s.destructive ?? "oklch(0.58 0.21 25)",
    "--border": s.border,
    "--input": s.input ?? s.border,
    "--ring": s.ring ?? s.primary,
    "--chart-1": s.primary,
    "--chart-2": "oklch(0.68 0.14 162)",
    "--chart-3": "oklch(0.72 0.12 224)",
    "--chart-4": "oklch(0.8 0.13 85)",
    "--chart-5": "oklch(0.64 0.2 12)",
    "--radius": radius,
    "--sidebar": s.sidebar,
    "--sidebar-foreground": s.sidebarFg,
    "--sidebar-primary": s.sidebarPrimary ?? s.primary,
    "--sidebar-primary-foreground": s.sidebarPrimaryFg ?? s.primaryFg,
    "--sidebar-accent": s.sidebarAccent,
    "--sidebar-accent-foreground": s.sidebarAccentFg ?? s.sidebarFg,
    "--sidebar-border": s.sidebarBorder ?? s.border,
    "--sidebar-ring": s.sidebarRing ?? s.ring ?? s.primary,
  }
}

const WHITE_OVERLAY = "oklch(1 0 0 / 0.12)"
const DARK_OVERLAY = "oklch(0.45 0 0 / 0.09)"

/* ─── IntelliJ 시그니처 색 ───────────────────────────────────────────── */

/** New UI 액션 블루(선택된 항목·기본 버튼). */
const IDEA_BLUE = "#3574F0"
/** Darcula 리스트 선택 블루. */
const DARCULA_SELECT = "#4B6EAF"

/* ─── Raycast 시그니처 색 ────────────────────────────────────────────── */

/**
 * Raycast 테마의 loader 색(코럴 레드) — 로딩 바·강조에 쓰이는 시그니처 색이다.
 * Raycast 테마 스키마는 background / backgroundSecondary / text / selection /
 * loader + 7색(red·orange·yellow·green·blue·purple·magenta) 12슬롯이다.
 */
const RAYCAST_CORAL = "#FF6363"

/**
 * Darcula 는 IntelliJ 에서 다크 전용 테마라 라이트 변형이 없다.
 * 라이트/다크 토글과 무관하게 같은 팔레트를 쓰도록 한 번만 만들어 양쪽에 넣는다.
 */
const DARCULA_VARS = makeVars("0.4rem", {
  bg: "#2B2B2B",
  fg: "#A9B7C6",
  card: "#313335",
  primary: DARCULA_SELECT,
  primaryFg: "#FFFFFF",
  secondary: "#3C3F41",
  secondaryFg: "#BBBBBB",
  muted: "#3C3F41",
  mutedFg: "#8C8C8C",
  accent: "#2D5177",
  accentFg: "#D2E4F7",
  destructive: "#CF5B56",
  border: "#323232",
  input: "#5E6060",
  ring: DARCULA_SELECT,
  sidebar: "#3C3F41",
  sidebarFg: "#BBBBBB",
  sidebarAccent: DARCULA_SELECT,
  sidebarAccentFg: "#FFFFFF",
  sidebarBorder: "#323232",
})

export const PRESETS: ThemePreset[] = [
  {
    id: "slack",
    label: "Slack",
    description: "오버진(가지색) 사이드바 + 흰 콘텐츠 + Slack 그린",
    light: makeVars("0.5rem", {
      bg: "oklch(1 0 0)",
      fg: "oklch(0.22 0.006 340)",
      primary: "oklch(0.52 0.11 165)",
      primaryFg: "oklch(0.985 0.005 165)",
      muted: "oklch(0.965 0.004 330)",
      mutedFg: "oklch(0.55 0.012 340)",
      accent: "oklch(0.955 0.014 328)",
      accentFg: "oklch(0.32 0.09 328)",
      destructive: "oklch(0.575 0.21 8)",
      border: "oklch(0.9 0.005 330)",
      sidebar: "oklch(0.245 0.105 328)",
      sidebarFg: "oklch(0.93 0.012 330)",
      sidebarPrimary: "oklch(0.56 0.13 248)",
      sidebarAccent: WHITE_OVERLAY,
      sidebarAccentFg: "oklch(0.985 0.005 330)",
      sidebarBorder: "oklch(1 0 0 / 0.1)",
      sidebarRing: "oklch(0.56 0.13 248)",
    }),
    dark: makeVars("0.5rem", {
      bg: "oklch(0.17 0.008 340)",
      fg: "oklch(0.95 0.004 330)",
      card: "oklch(0.205 0.008 340)",
      primary: "oklch(0.62 0.12 163)",
      primaryFg: "oklch(0.15 0.02 165)",
      muted: "oklch(0.26 0.008 340)",
      mutedFg: "oklch(0.7 0.012 330)",
      accent: "oklch(0.3 0.03 328)",
      accentFg: "oklch(0.92 0.02 328)",
      destructive: "oklch(0.62 0.2 8)",
      border: "oklch(1 0 0 / 0.1)",
      input: "oklch(1 0 0 / 0.14)",
      sidebar: "oklch(0.23 0.1 328)",
      sidebarFg: "oklch(0.92 0.012 330)",
      sidebarPrimary: "oklch(0.6 0.13 248)",
      sidebarAccent: WHITE_OVERLAY,
      sidebarAccentFg: "oklch(0.985 0.005 330)",
      sidebarBorder: "oklch(1 0 0 / 0.1)",
      sidebarRing: "oklch(0.6 0.13 248)",
    }),
  },
  {
    id: "claude",
    label: "Claude",
    description: "따뜻한 아이보리 종이 톤 + 코럴 포인트",
    light: makeVars("0.6rem", {
      bg: "oklch(0.985 0.006 90)",
      fg: "oklch(0.28 0.008 75)",
      card: "oklch(1 0 0)",
      primary: "oklch(0.58 0.13 40)",
      primaryFg: "oklch(0.99 0.005 90)",
      muted: "oklch(0.955 0.01 85)",
      mutedFg: "oklch(0.53 0.01 80)",
      accent: "oklch(0.93 0.025 60)",
      accentFg: "oklch(0.42 0.11 40)",
      border: "oklch(0.9 0.012 85)",
      sidebar: "oklch(0.955 0.011 85)",
      sidebarFg: "oklch(0.34 0.01 75)",
      sidebarAccent: "oklch(0.6 0.13 40 / 0.12)",
      sidebarAccentFg: "oklch(0.45 0.12 40)",
      sidebarBorder: "oklch(0.9 0.012 85)",
    }),
    dark: makeVars("0.6rem", {
      bg: "oklch(0.24 0.004 75)",
      fg: "oklch(0.95 0.006 90)",
      card: "oklch(0.27 0.004 75)",
      primary: "oklch(0.67 0.13 42)",
      primaryFg: "oklch(0.18 0.02 60)",
      muted: "oklch(0.3 0.004 75)",
      mutedFg: "oklch(0.72 0.008 85)",
      accent: "oklch(0.34 0.02 55)",
      accentFg: "oklch(0.9 0.03 55)",
      border: "oklch(1 0 0 / 0.09)",
      input: "oklch(1 0 0 / 0.13)",
      sidebar: "oklch(0.205 0.004 75)",
      sidebarFg: "oklch(0.9 0.008 85)",
      sidebarAccent: "oklch(0.67 0.13 42 / 0.18)",
      sidebarAccentFg: "oklch(0.85 0.08 45)",
      sidebarBorder: "oklch(1 0 0 / 0.08)",
    }),
  },
  {
    id: "apple",
    label: "Apple",
    description: "macOS 시스템 그레이 + Apple 블루",
    light: makeVars("0.75rem", {
      bg: "oklch(1 0 0)",
      fg: "oklch(0.22 0.004 260)",
      primary: "oklch(0.62 0.2 258)",
      primaryFg: "oklch(0.99 0 0)",
      muted: "oklch(0.965 0.002 260)",
      mutedFg: "oklch(0.55 0.006 260)",
      accent: "oklch(0.95 0.02 258)",
      accentFg: "oklch(0.5 0.15 258)",
      border: "oklch(0.9 0.003 260)",
      sidebar: "oklch(0.955 0.002 260)",
      sidebarFg: "oklch(0.28 0.004 260)",
      sidebarAccent: "oklch(0.62 0.2 258 / 0.14)",
      sidebarAccentFg: "oklch(0.5 0.17 258)",
      sidebarBorder: "oklch(0.9 0.003 260)",
    }),
    dark: makeVars("0.75rem", {
      bg: "oklch(0.21 0.004 260)",
      fg: "oklch(0.96 0.002 260)",
      card: "oklch(0.26 0.004 260)",
      primary: "oklch(0.64 0.19 256)",
      primaryFg: "oklch(0.99 0 0)",
      muted: "oklch(0.28 0.004 260)",
      mutedFg: "oklch(0.72 0.006 260)",
      accent: "oklch(0.32 0.02 258)",
      accentFg: "oklch(0.85 0.08 258)",
      border: "oklch(1 0 0 / 0.1)",
      input: "oklch(1 0 0 / 0.14)",
      sidebar: "oklch(0.185 0.004 260)",
      sidebarFg: "oklch(0.92 0.004 260)",
      sidebarAccent: "oklch(0.64 0.19 256 / 0.2)",
      sidebarAccentFg: "oklch(0.85 0.09 256)",
      sidebarBorder: "oklch(1 0 0 / 0.08)",
    }),
  },
  {
    id: "linear",
    label: "Linear",
    description: "차분한 다크 + 인디고 퍼플, 미니멀",
    light: makeVars("0.5rem", {
      bg: "oklch(0.99 0.002 275)",
      fg: "oklch(0.24 0.008 275)",
      primary: "oklch(0.56 0.15 275)",
      primaryFg: "oklch(0.99 0 0)",
      muted: "oklch(0.965 0.004 275)",
      mutedFg: "oklch(0.54 0.01 275)",
      accent: "oklch(0.95 0.02 275)",
      accentFg: "oklch(0.45 0.13 275)",
      border: "oklch(0.91 0.005 275)",
      sidebar: "oklch(0.965 0.004 275)",
      sidebarFg: "oklch(0.3 0.008 275)",
      sidebarAccent: DARK_OVERLAY,
      sidebarBorder: "oklch(0.91 0.005 275)",
    }),
    dark: makeVars("0.5rem", {
      bg: "oklch(0.18 0.006 275)",
      fg: "oklch(0.93 0.004 275)",
      card: "oklch(0.21 0.006 275)",
      primary: "oklch(0.62 0.15 275)",
      primaryFg: "oklch(0.99 0 0)",
      muted: "oklch(0.25 0.006 275)",
      mutedFg: "oklch(0.68 0.008 275)",
      accent: "oklch(0.3 0.03 275)",
      accentFg: "oklch(0.88 0.04 275)",
      border: "oklch(1 0 0 / 0.09)",
      input: "oklch(1 0 0 / 0.12)",
      sidebar: "oklch(0.15 0.006 275)",
      sidebarFg: "oklch(0.85 0.006 275)",
      sidebarAccent: WHITE_OVERLAY,
      sidebarBorder: "oklch(1 0 0 / 0.07)",
    }),
  },
  {
    id: "notion",
    label: "Notion",
    description: "깔끔한 무채색 + 절제된 블루, 문서 느낌",
    light: makeVars("0.4rem", {
      bg: "oklch(1 0 0)",
      fg: "oklch(0.24 0 0)",
      primary: "oklch(0.58 0.14 245)",
      primaryFg: "oklch(0.99 0 0)",
      muted: "oklch(0.97 0.002 90)",
      mutedFg: "oklch(0.56 0.004 80)",
      accent: "oklch(0.955 0.003 90)",
      accentFg: "oklch(0.3 0 0)",
      border: "oklch(0.925 0.002 90)",
      sidebar: "oklch(0.975 0.003 90)",
      sidebarFg: "oklch(0.34 0.004 80)",
      sidebarAccent: DARK_OVERLAY,
      sidebarBorder: "oklch(0.925 0.002 90)",
    }),
    dark: makeVars("0.4rem", {
      bg: "oklch(0.22 0 0)",
      fg: "oklch(0.93 0 0)",
      card: "oklch(0.25 0 0)",
      primary: "oklch(0.66 0.14 245)",
      primaryFg: "oklch(0.99 0 0)",
      muted: "oklch(0.27 0 0)",
      mutedFg: "oklch(0.7 0 0)",
      accent: "oklch(0.3 0 0)",
      accentFg: "oklch(0.9 0 0)",
      border: "oklch(1 0 0 / 0.1)",
      input: "oklch(1 0 0 / 0.13)",
      sidebar: "oklch(0.25 0 0)",
      sidebarFg: "oklch(0.85 0 0)",
      sidebarAccent: WHITE_OVERLAY,
      sidebarBorder: "oklch(1 0 0 / 0.08)",
    }),
  },
  {
    id: "spotify",
    label: "Spotify",
    description: "블랙 사이드바 + 시그니처 그린, 몰입형 다크",
    light: makeVars("0.75rem", {
      bg: "oklch(1 0 0)",
      fg: "oklch(0.2 0 0)",
      primary: "oklch(0.68 0.17 150)",
      primaryFg: "oklch(0.16 0.02 150)",
      muted: "oklch(0.965 0.002 150)",
      mutedFg: "oklch(0.52 0.004 150)",
      accent: "oklch(0.94 0.04 150)",
      accentFg: "oklch(0.4 0.1 150)",
      border: "oklch(0.9 0.003 150)",
      sidebar: "oklch(0.965 0.002 150)",
      sidebarFg: "oklch(0.28 0.004 150)",
      sidebarAccent: DARK_OVERLAY,
      sidebarBorder: "oklch(0.9 0.003 150)",
    }),
    dark: makeVars("0.75rem", {
      bg: "oklch(0.205 0 0)",
      fg: "oklch(0.97 0 0)",
      card: "oklch(0.24 0 0)",
      primary: "oklch(0.72 0.18 150)",
      primaryFg: "oklch(0.16 0.03 150)",
      muted: "oklch(0.28 0 0)",
      mutedFg: "oklch(0.74 0 0)",
      accent: "oklch(0.32 0.03 150)",
      accentFg: "oklch(0.85 0.1 150)",
      border: "oklch(1 0 0 / 0.1)",
      input: "oklch(1 0 0 / 0.14)",
      sidebar: "oklch(0.14 0 0)",
      sidebarFg: "oklch(0.88 0 0)",
      sidebarPrimary: "oklch(0.72 0.18 150)",
      sidebarAccent: WHITE_OVERLAY,
      sidebarBorder: "oklch(1 0 0 / 0.08)",
    }),
  },
  {
    id: "discord",
    label: "Discord",
    description: "블러플(Blurple) 포인트 + 부드러운 다크 그레이",
    light: makeVars("0.75rem", {
      bg: "oklch(1 0 0)",
      fg: "oklch(0.32 0.006 285)",
      primary: "oklch(0.58 0.2 274)",
      primaryFg: "oklch(0.99 0 0)",
      muted: "oklch(0.965 0.003 285)",
      mutedFg: "oklch(0.53 0.008 285)",
      accent: "oklch(0.95 0.02 274)",
      accentFg: "oklch(0.48 0.16 274)",
      border: "oklch(0.9 0.004 285)",
      sidebar: "oklch(0.96 0.004 285)",
      sidebarFg: "oklch(0.34 0.008 285)",
      sidebarAccent: DARK_OVERLAY,
      sidebarBorder: "oklch(0.9 0.004 285)",
    }),
    dark: makeVars("0.75rem", {
      bg: "oklch(0.32 0.006 285)",
      fg: "oklch(0.95 0.003 285)",
      card: "oklch(0.3 0.006 285)",
      primary: "oklch(0.58 0.2 274)",
      primaryFg: "oklch(0.99 0 0)",
      muted: "oklch(0.36 0.006 285)",
      mutedFg: "oklch(0.78 0.006 285)",
      accent: "oklch(0.4 0.04 274)",
      accentFg: "oklch(0.9 0.05 274)",
      border: "oklch(1 0 0 / 0.08)",
      input: "oklch(1 0 0 / 0.12)",
      sidebar: "oklch(0.24 0.006 285)",
      sidebarFg: "oklch(0.86 0.006 285)",
      sidebarPrimary: "oklch(0.58 0.2 274)",
      sidebarAccent: WHITE_OVERLAY,
      sidebarBorder: "oklch(1 0 0 / 0.07)",
    }),
  },
  // IntelliJ IDEA. New UI(2022.3+) 의 Light/Dark 와 클래식 Darcula 두 갈래.
  {
    id: "intellij",
    label: "IntelliJ",
    description: "New UI — 뉴트럴 패널 + JetBrains 블루",
    light: makeVars("0.4rem", {
      bg: "#FFFFFF",
      fg: "#1E1F22",
      primary: IDEA_BLUE,
      primaryFg: "#FFFFFF",
      secondary: "#F7F8FA",
      secondaryFg: "#1E1F22",
      muted: "#F7F8FA",
      mutedFg: "#6C707E",
      accent: "#D4E2FF",
      accentFg: "#1E3C8C",
      border: "#EBECF0",
      input: "#C9CCD6",
      ring: IDEA_BLUE,
      sidebar: "#F7F8FA",
      sidebarFg: "#1E1F22",
      sidebarAccent: "#D4E2FF",
      sidebarAccentFg: "#1E3C8C",
      sidebarBorder: "#EBECF0",
    }),
    dark: makeVars("0.4rem", {
      bg: "#1E1F22",
      fg: "#DFE1E5",
      card: "#2B2D30",
      primary: "#548AF7",
      primaryFg: "#0E1013",
      secondary: "#2B2D30",
      secondaryFg: "#DFE1E5",
      muted: "#2B2D30",
      mutedFg: "#9DA0A8",
      accent: "#2E436E",
      accentFg: "#C7DBFF",
      border: "#393B40",
      input: "#4A4C51",
      ring: "#548AF7",
      sidebar: "#2B2D30",
      sidebarFg: "#DFE1E5",
      sidebarAccent: "#2E436E",
      sidebarAccentFg: "#C7DBFF",
      sidebarBorder: "#393B40",
    }),
  },
  {
    id: "intellij-darcula",
    label: "IntelliJ Darcula",
    description: "클래식 다크 전용 — 웜 그레이 + 오렌지 키워드",
    // 다크 전용. forcedMode 로 .dark 클래스까지 고정되므로 양쪽 블록이 같아도 된다.
    forcedMode: "dark",
    light: DARCULA_VARS,
    dark: DARCULA_VARS,
  },
  {
    id: "raycast",
    label: "Raycast",
    description: "니어블랙 커맨드 팔레트 + 코럴 레드 포인트",
    light: makeVars("0.625rem", {
      bg: "#FFFFFF",
      fg: "#1A1A1A",
      primary: RAYCAST_CORAL,
      // 코럴 위 흰 글자는 대비 2.9:1 뿐이라 어두운 글자를 쓴다.
      primaryFg: "#1A1A1A",
      secondary: "#F5F5F5",
      secondaryFg: "#1A1A1A",
      muted: "#F5F5F5",
      mutedFg: "#6E6E6E",
      accent: "#FFE9E9",
      accentFg: "#A83B3B",
      destructive: "#F50A0A",
      border: "#E5E5E5",
      input: "#D4D4D4",
      ring: RAYCAST_CORAL,
      sidebar: "#F5F5F5",
      sidebarFg: "#1A1A1A",
      // Raycast 리스트 선택은 색이 아니라 은은한 회색 하이라이트다.
      sidebarAccent: "#E5E5E5",
      sidebarAccentFg: "#1A1A1A",
      sidebarBorder: "#E5E5E5",
    }),
    dark: makeVars("0.625rem", {
      bg: "#1A1A1A",
      fg: "#FFFFFF",
      card: "#212121",
      primary: RAYCAST_CORAL,
      primaryFg: "#1A1A1A",
      secondary: "#262626",
      secondaryFg: "#F5F5F5",
      muted: "#262626",
      mutedFg: "#8A8A8A",
      accent: "#333333",
      accentFg: "#FFB3B3",
      destructive: "#FF5C5C",
      border: "#2E2E2E",
      input: "#3A3A3A",
      ring: RAYCAST_CORAL,
      sidebar: "#121212",
      sidebarFg: "#E8E8E8",
      sidebarAccent: "#333333",
      sidebarAccentFg: "#FFFFFF",
      sidebarBorder: "#2A2A2A",
    }),
  },
]

export const DEFAULT_PRESET_ID = "slack"

export function getPreset(id: string): ThemePreset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0]
}

/** 프리셋을 index.css 를 덮어쓸 CSS 문자열(:root / .dark 블록)로 직렬화한다. */
export function presetToCss(preset: ThemePreset): string {
  const block = (selector: string, vars: ThemeVars) =>
    `${selector}{${Object.entries(vars)
      .map(([k, v]) => `${k}:${v};`)
      .join("")}}`
  return block(":root", preset.light) + block(".dark", preset.dark)
}
