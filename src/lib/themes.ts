/**
 * 앱 디자인 프리셋(테마) 모음.
 *
 * 각 프리셋은 유명 앱의 색감을 흉내 낸 CSS 변수 세트를 라이트/다크 모드별로 정의한다.
 * 선택된 프리셋은 theme-preset-provider 가 `<style>` 로 문서에 주입하며, index.css 의
 * 기본값(:root / .dark)을 덮어쓴다. 라이트/다크 전환(theme-provider)과는 독립적이다.
 *
 * 기본 프리셋은 `slack` 이다 — 앱 전체 외형이 Slack 데스크톱 앱을 기준으로 만들어져 있고
 * (15px 본문 · 8px 라운드 · 부드러운 그림자), 다른 프리셋은 그 위의 색 변형으로만 동작한다.
 * 즉 프리셋은 **색만** 바꾸고 구조·밀도·타이포는 건드리지 않는다.
 *
 * 프리셋은 본문 색 외에 **크롬 색도 공급한다**(`chrome` / `chromeFg` / `selection` / `selectionFg`).
 * 그래서 프리셋을 바꾸면 상단바 · 좌측 레일 · 상태바 · 활성 내비 알약이 그 색으로 함께 바뀐다.
 * 나머지 `--ui-*`(탭·배지·위젯·상태색 등)는 index.css 에만 있고 프리셋이 건드리지 않는다.
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
  /**
   * 상단바 + 좌측 레일 배경. **브랜드 정색을 진하게** 깐다(연한 틴트가 아니다) —
   * 포인트 컬러가 화면 좌·상단에서 바로 보이게 하는 것이 이 토큰의 목적이다.
   */
  chrome: string
  /** 크롬 위 글자·아이콘 색. 크롬이 진하므로 사실상 항상 흰색이다. */
  chromeFg: string
  /** 활성 내비 항목 알약 배경. 같은 브랜드 색의 **더 밝은 톤**을 쓴다. 없으면 primary. */
  selection?: string
  /** 활성 내비 항목 글자색. 없으면 흰색. */
  selectionFg?: string
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
   * 원본에 한쪽 모드만 있는 테마라면 여기에 그 모드를 적는다.
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
    /*
     * 크롬 4색. index.css 가 --ui-titlebar / --ui-activitybar / --ui-statusbar / --ui-list-active
     * 에서 이 값을 참조하므로, 프리셋을 바꾸면 상단바·레일·상태바·활성 알약이 함께 바뀐다.
     * hover/활성 타일/비활성 글자는 index.css 가 --ui-chrome-fg 에서 color-mix 로 파생한다.
     */
    "--ui-chrome": s.chrome,
    "--ui-chrome-fg": s.chromeFg,
    "--ui-selection": s.selection ?? s.primary,
    "--ui-selection-fg": s.selectionFg ?? "#FFFFFF",
  }
}

/** Slack 미학에 맞춘 공통 라운드 — 프리셋은 색만 바꾸므로 6개 전부 같은 값을 쓴다. */
const RADIUS = "0.5rem"

const WHITE_OVERLAY = "oklch(1 0 0 / 0.12)"
const DARK_OVERLAY = "oklch(0.45 0 0 / 0.09)"

/* ─── Slack 시그니처 색 ──────────────────────────────────────────────── */

/** 활성 내비 알약의 와인색(스크린샷의 선택된 채널). */
const SLACK_WINE = "#8B1D41"

/* ─── IntelliJ 시그니처 색 ───────────────────────────────────────────── */

/** Claude 시그니처 코럴(활성 알약·버튼). */
const CLAUDE_CORAL = "#D97757"

/** New UI 액션 블루(선택된 항목·기본 버튼). */
const IDEA_BLUE = "#3574F0"

/* ─── Raycast 시그니처 색 ────────────────────────────────────────────── */

/**
 * Raycast 테마의 loader 색(코럴 레드) — 로딩 바·강조에 쓰이는 시그니처 색이다.
 * Raycast 테마 스키마는 background / backgroundSecondary / text / selection /
 * loader + 7색(red·orange·yellow·green·blue·purple·magenta) 12슬롯이다.
 */
const RAYCAST_CORAL = "#FF6363"

export const PRESETS: ThemePreset[] = [
  // 기본 프리셋. index.css 의 :root / .dark 와 같은 값이라 선택해도 외형이 변하지 않는다.
  {
    id: "slack",
    label: "Slack",
    description: "오버진 크롬 + 흰 패널 + 와인색 선택 알약",
    light: {
      ...makeVars(RADIUS, {
        bg: "#FFFFFF",
        fg: "#1D1C1D",
        card: "#FFFFFF",
        cardFg: "#1D1C1D",
        popover: "#FFFFFF",
        primary: "#007A5A",
        primaryFg: "#FFFFFF",
        secondary: "#F6F6F6",
        secondaryFg: "#1D1C1D",
        muted: "#F6F6F6",
        mutedFg: "#616061",
        accent: "#F4E7EC",
        accentFg: SLACK_WINE,
        destructive: "#E01E5A",
        border: "#E0E0E0",
        input: "#C9C9C9",
        ring: "#1264A3",
        sidebar: "#FFFFFF",
        sidebarFg: "#1D1C1D",
        sidebarPrimary: SLACK_WINE,
        sidebarPrimaryFg: "#FFFFFF",
        sidebarAccent: SLACK_WINE,
        sidebarAccentFg: "#FFFFFF",
        sidebarBorder: "#E0E0E0",
        sidebarRing: "#1264A3",
        chrome: "#4A154B",
        chromeFg: "#FFFFFF",
        selection: SLACK_WINE,
        selectionFg: "#FFFFFF",
      }),
      // makeVars 는 차트 색을 oklch 기본값으로 채우므로 Slack 브랜드 4색 + 자주로 덮어쓴다.
      "--chart-1": "#36C5F0",
      "--chart-2": "#2EB67D",
      "--chart-3": "#ECB22E",
      "--chart-4": "#E01E5A",
      "--chart-5": "#4A154B",
    },
    dark: {
      ...makeVars(RADIUS, {
        bg: "#1A1D21",
        fg: "#D1D2D3",
        card: "#222529",
        cardFg: "#D1D2D3",
        popover: "#222529",
        primary: "#148567",
        primaryFg: "#FFFFFF",
        secondary: "#27242C",
        secondaryFg: "#D1D2D3",
        muted: "#27242C",
        mutedFg: "#ABABAD",
        accent: "#3A2430",
        accentFg: "#F0C4D3",
        destructive: "#E01E5A",
        border: "#35373B",
        input: "#565856",
        ring: "#1D9BD1",
        sidebar: "#1A1D21",
        sidebarFg: "#D1D2D3",
        sidebarPrimary: SLACK_WINE,
        sidebarPrimaryFg: "#FFFFFF",
        sidebarAccent: SLACK_WINE,
        sidebarAccentFg: "#FFFFFF",
        sidebarBorder: "#35373B",
        sidebarRing: "#1D9BD1",
        chrome: "#3A1039",
        chromeFg: "#FFFFFF",
        selection: SLACK_WINE,
        selectionFg: "#FFFFFF",
      }),
      "--chart-1": "#36C5F0",
      "--chart-2": "#2EB67D",
      "--chart-3": "#ECB22E",
      "--chart-4": "#E01E5A",
      "--chart-5": "#A97FAA",
    },
  },
  {
    id: "vscode",
    label: "VS Code",
    description: "Dark Modern / Light Modern — 에디터 워크벤치 톤",
    light: {
      ...makeVars(RADIUS, {
        bg: "#FFFFFF",
        fg: "#3B3B3B",
        card: "#F8F8F8",
        cardFg: "#3B3B3B",
        popover: "#FFFFFF",
        primary: "#005FB8",
        primaryFg: "#FFFFFF",
        secondary: "#E5E5E5",
        secondaryFg: "#3B3B3B",
        muted: "#F3F3F3",
        mutedFg: "#616161",
        accent: "#E8E8E8",
        accentFg: "#000000",
        destructive: "#E51400",
        border: "#E5E5E5",
        input: "#CECECE",
        ring: "#005FB8",
        sidebar: "#F8F8F8",
        sidebarFg: "#3B3B3B",
        sidebarPrimary: "#005FB8",
        sidebarPrimaryFg: "#FFFFFF",
        sidebarAccent: "#E8E8E8",
        sidebarAccentFg: "#000000",
        sidebarBorder: "#E5E5E5",
        sidebarRing: "#005FB8",
        chrome: "#0E639C",
        chromeFg: "#FFFFFF",
        selection: "#0078D4",
        selectionFg: "#FFFFFF",
      }),
      // makeVars 는 차트 색을 oklch 기본값으로 채우므로 VS Code 진단 색으로 덮어쓴다.
      "--chart-1": "#1A85FF",
      "--chart-2": "#388A34",
      "--chart-3": "#B58900",
      "--chart-4": "#E51400",
      "--chart-5": "#652D90",
    },
    dark: {
      ...makeVars(RADIUS, {
        bg: "#1F1F1F",
        fg: "#CCCCCC",
        card: "#202020",
        cardFg: "#CCCCCC",
        popover: "#202020",
        primary: "#0078D4",
        primaryFg: "#FFFFFF",
        secondary: "#313131",
        secondaryFg: "#CCCCCC",
        muted: "#313131",
        mutedFg: "#9D9D9D",
        accent: "#04395E",
        accentFg: "#FFFFFF",
        destructive: "#F85149",
        border: "#2B2B2B",
        input: "#3C3C3C",
        ring: "#0078D4",
        sidebar: "#181818",
        sidebarFg: "#CCCCCC",
        sidebarPrimary: "#0078D4",
        sidebarPrimaryFg: "#FFFFFF",
        sidebarAccent: "#04395E",
        sidebarAccentFg: "#FFFFFF",
        sidebarBorder: "#2B2B2B",
        sidebarRing: "#0078D4",
        chrome: "#0B4A75",
        chromeFg: "#FFFFFF",
        selection: "#0078D4",
        selectionFg: "#FFFFFF",
      }),
      "--chart-1": "#3794FF",
      "--chart-2": "#89D185",
      "--chart-3": "#CCA700",
      "--chart-4": "#F14C4C",
      "--chart-5": "#C586C0",
    },
  },
  {
    id: "claude",
    label: "Claude",
    description: "따뜻한 아이보리 종이 톤 + 코럴 포인트",
    light: makeVars(RADIUS, {
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
      chrome: "#A64B2A",
      chromeFg: "#FFFFFF",
      selection: CLAUDE_CORAL,
      selectionFg: "#FFFFFF",
    }),
    dark: makeVars(RADIUS, {
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
      chrome: "#7E3820",
      chromeFg: "#FFFFFF",
      selection: CLAUDE_CORAL,
      selectionFg: "#FFFFFF",
    }),
  },
  // IntelliJ IDEA New UI(2022.3+) 의 Light / Dark.
  {
    id: "intellij",
    label: "IntelliJ",
    description: "New UI — 뉴트럴 패널 + JetBrains 블루",
    light: makeVars(RADIUS, {
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
      chrome: "#2B4B8F",
      chromeFg: "#FFFFFF",
      selection: IDEA_BLUE,
      selectionFg: "#FFFFFF",
    }),
    dark: makeVars(RADIUS, {
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
      chrome: "#1F3768",
      chromeFg: "#FFFFFF",
      selection: IDEA_BLUE,
      selectionFg: "#FFFFFF",
    }),
  },
  {
    id: "discord",
    label: "Discord",
    description: "블러플(Blurple) 포인트 + 부드러운 다크 그레이",
    light: makeVars(RADIUS, {
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
      chrome: "#4650E0",
      chromeFg: "#FFFFFF",
      selection: "#5865F2",
      selectionFg: "#FFFFFF",
    }),
    dark: makeVars(RADIUS, {
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
      chrome: "#3640B4",
      chromeFg: "#FFFFFF",
      selection: "#5865F2",
      selectionFg: "#FFFFFF",
    }),
  },
  {
    id: "raycast",
    label: "Raycast",
    description: "니어블랙 커맨드 팔레트 + 코럴 레드 포인트",
    light: makeVars(RADIUS, {
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
      chrome: "#C4433F",
      chromeFg: "#FFFFFF",
      selection: RAYCAST_CORAL,
      // 여기도 같은 이유로 알약 위 글자만 어둡게 둔다.
      selectionFg: "#1A1A1A",
    }),
    dark: makeVars(RADIUS, {
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
      chrome: "#93302D",
      chromeFg: "#FFFFFF",
      selection: RAYCAST_CORAL,
      selectionFg: "#1A1A1A",
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
