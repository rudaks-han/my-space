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

const STORAGE_KEY = "myspace.themePreset"
const STYLE_ELEMENT_ID = "theme-preset-vars"

type ThemePresetState = {
  presetId: string
  preset: ThemePreset
  presets: ThemePreset[]
  setPreset: (id: string) => void
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

function readStored(): string {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored && PRESETS.some((p) => p.id === stored)) {
    return stored
  }
  return DEFAULT_PRESET_ID
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

  // 첫 페인트 전에 주입해 깜빡임을 줄인다.
  React.useLayoutEffect(() => {
    applyPresetStyle(getPreset(presetId))
  }, [presetId])

  const setPreset = React.useCallback((id: string) => {
    localStorage.setItem(STORAGE_KEY, id)
    setPresetId(id)
  }, [])

  // 다른 창(위젯 등)에서 프리셋을 바꾸면 이 창에도 반영한다.
  React.useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea !== localStorage || e.key !== STORAGE_KEY) return
      setPresetId(readStored())
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
    }),
    [presetId, setPreset]
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
