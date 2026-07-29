/* eslint-disable react-refresh/only-export-components */
import * as React from "react"

import { ThemeProvider } from "@/components/theme-provider"
import {
  DEFAULT_PRESET_ID,
  PRESETS,
  getPreset,
  presetToCss,
  type ThemePreset,
} from "@/lib/themes"
import {
  SLACK_THEME_GROUPS,
  getSlackTheme,
  type SlackTheme,
  type SlackThemeGroup,
} from "@/lib/slack-themes"
import { DEFAULT_FONT_ID, FONTS, getFont, type AppFont } from "@/lib/fonts"

const STORAGE_KEY = "myspace.themePreset"
const STYLE_ELEMENT_ID = "theme-preset-vars"

const SLACK_STORAGE_KEY = "myspace.slackTheme"
const SLACK_STYLE_ELEMENT_ID = "slack-theme-vars"

const FONT_STORAGE_KEY = "myspace.font"
const FONT_STYLE_ELEMENT_ID = "font-vars"

type ThemePresetState = {
  presetId: string
  preset: ThemePreset
  presets: ThemePreset[]
  setPreset: (id: string) => void
  /** 선택된 Slack 사이드바 테마 id. null 이면 프리셋의 크롬 색을 그대로 쓴다. */
  slackThemeId: string | null
  slackTheme: SlackTheme | null
  slackThemeGroups: SlackThemeGroup[]
  setSlackTheme: (id: string | null) => void
  /** 선택된 본문 폰트 id. */
  fontId: string
  font: AppFont
  fonts: AppFont[]
  setFont: (id: string) => void
}

const ThemePresetContext = React.createContext<ThemePresetState | undefined>(
  undefined
)

/** 선택된 프리셋의 CSS 변수를 <head> 의 <style> 로 주입/갱신한다. */
function applyPresetStyle(preset: ThemePreset) {
  let el = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement("style")
    el.id = STYLE_ELEMENT_ID
    document.head.appendChild(el)
  }
  el.textContent = presetToCss(preset)
}

/**
 * Slack 사이드바 테마의 크롬 색을 주입/해제한다.
 *
 * 프리셋 `<style>` 보다 **뒤에** 붙어야 이긴다 — `:root` 와 `.dark` 는 명시도가 같아서
 * 순서로 결정되기 때문이다. 두 셀렉터에 같은 값을 넣어 모드와 무관하게 적용한다.
 * `--ui-chrome-fg` 만 덮어써도 index.css 의 hover/활성 타일/비활성 글자는 color-mix 로
 * 따라오므로 여기서는 2개 변수만 지정한다.
 */
function applySlackThemeStyle(theme: SlackTheme | null) {
  let el = document.getElementById(
    SLACK_STYLE_ELEMENT_ID
  ) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement("style")
    el.id = SLACK_STYLE_ELEMENT_ID
    document.head.appendChild(el)
  }
  if (!theme) {
    el.textContent = ""
    return
  }
  const vars = `--ui-chrome:${theme.chrome};--ui-chrome-fg:${theme.chromeFg};`
  el.textContent = `:root{${vars}}.dark{${vars}}`
}

/** 선택된 폰트의 font-family 스택을 `--ui-font` 로 주입한다. */
function applyFontStyle(font: AppFont) {
  let el = document.getElementById(
    FONT_STYLE_ELEMENT_ID
  ) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement("style")
    el.id = FONT_STYLE_ELEMENT_ID
    document.head.appendChild(el)
  }
  el.textContent = `:root{--ui-font:${font.stack};}`
}

function readStored(): string {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored && PRESETS.some((p) => p.id === stored)) {
    return stored
  }
  return DEFAULT_PRESET_ID
}

function readStoredFont(): string {
  const stored = localStorage.getItem(FONT_STORAGE_KEY)
  if (stored && FONTS.some((f) => f.id === stored)) {
    return stored
  }
  return DEFAULT_FONT_ID
}

function readStoredSlackTheme(): string | null {
  const stored = localStorage.getItem(SLACK_STORAGE_KEY)
  return getSlackTheme(stored)?.id ?? null
}

/**
 * 디자인 프리셋을 앱 전역에 적용한다. 라이트/다크 토글(theme-provider)과 독립적으로
 * 동작하며, 두 모드의 색을 모두 주입하므로 프리셋만 바꿔도 현재 모드에 맞게 반영된다.
 */
export function ThemePresetProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [presetId, setPresetId] = React.useState<string>(readStored)
  const [slackThemeId, setSlackThemeId] = React.useState<string | null>(
    readStoredSlackTheme
  )
  const [fontId, setFontId] = React.useState<string>(readStoredFont)

  // 첫 페인트 전에 주입해 깜빡임을 줄인다.
  React.useLayoutEffect(() => {
    applyPresetStyle(getPreset(presetId))
  }, [presetId])

  // 프리셋 뒤에 선언해야 <style> 이 head 에서 더 뒤에 붙어 크롬 색을 이긴다.
  React.useLayoutEffect(() => {
    applySlackThemeStyle(getSlackTheme(slackThemeId))
  }, [slackThemeId])

  React.useLayoutEffect(() => {
    applyFontStyle(getFont(fontId))
  }, [fontId])

  const setPreset = React.useCallback((id: string) => {
    localStorage.setItem(STORAGE_KEY, id)
    setPresetId(id)
  }, [])

  const setSlackTheme = React.useCallback((id: string | null) => {
    if (id) localStorage.setItem(SLACK_STORAGE_KEY, id)
    else localStorage.removeItem(SLACK_STORAGE_KEY)
    setSlackThemeId(id)
  }, [])

  const setFont = React.useCallback((id: string) => {
    localStorage.setItem(FONT_STORAGE_KEY, id)
    setFontId(id)
  }, [])

  // 다른 창(위젯 등)에서 테마를 바꾸면 이 창에도 반영한다.
  React.useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea !== localStorage) return
      if (e.key === STORAGE_KEY) setPresetId(readStored())
      if (e.key === SLACK_STORAGE_KEY) setSlackThemeId(readStoredSlackTheme())
      if (e.key === FONT_STORAGE_KEY) setFontId(readStoredFont())
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  const value = React.useMemo(
    () => ({
      presetId,
      preset: getPreset(presetId),
      presets: PRESETS,
      setPreset,
      slackThemeId,
      slackTheme: getSlackTheme(slackThemeId),
      slackThemeGroups: SLACK_THEME_GROUPS,
      setSlackTheme,
      fontId,
      font: getFont(fontId),
      fonts: FONTS,
      setFont,
    }),
    [presetId, setPreset, slackThemeId, setSlackTheme, fontId, setFont]
  )

  return (
    <ThemePresetContext.Provider value={value}>
      {children}
    </ThemePresetContext.Provider>
  )
}

/** 프리셋의 forcedMode 를 라이트/다크 provider 에 연결한다. */
function ForcedModeThemeProvider({ children }: { children: React.ReactNode }) {
  const { preset } = useThemePreset()

  return (
    <ThemeProvider forcedTheme={preset.forcedMode}>{children}</ThemeProvider>
  )
}

/**
 * 테마 프리셋 + 라이트/다크 모드를 한 번에 제공한다.
 *
 * 프리셋이 먼저(바깥) 와야 다크 전용 프리셋일 때 ThemeProvider 에 forcedTheme 을
 * 넘겨 `.dark` 클래스까지 고정할 수 있다 — CSS 변수만 바꾸면 `dark:` 유틸리티가
 * 라이트 분기로 렌더돼 배지·상태 색이 어긋난다.
 */
export function ThemeProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemePresetProvider>
      <ForcedModeThemeProvider>{children}</ForcedModeThemeProvider>
    </ThemePresetProvider>
  )
}

export function useThemePreset(): ThemePresetState {
  const ctx = React.useContext(ThemePresetContext)
  if (ctx === undefined) {
    throw new Error(
      "useThemePreset 는 ThemePresetProvider 안에서만 사용할 수 있습니다."
    )
  }
  return ctx
}
