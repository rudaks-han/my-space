import { useCallback, useMemo, type ReactNode } from "react"

import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  SettingsContext,
  withDefaults,
  type AppSettings,
  type ClaudeCodeSettings,
  type CoworkSettings,
  type FlexSettings,
  type GeneralSettings,
  type GmailSettings,
  type MenuSettings,
  type PetSettings,
  type SlackSettings,
} from "@/features/settings/settings-context"
import { useLocalStorage } from "@/lib/use-local-storage"

/**
 * 설정 상태(localStorage)를 앱 전역에 공유한다. 설정 화면과 알림 로직이 같은 값을
 * 봐야 하므로(토글하면 즉시 반영되도록) Context 로 공유한다.
 *
 * 타입·기본값·useSettings 훅은 settings-context.ts 에 있다.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [raw, setRaw] = useLocalStorage<Partial<AppSettings>>(
    SETTINGS_STORAGE_KEY,
    DEFAULT_SETTINGS
  )

  const settings = useMemo(() => withDefaults(raw), [raw])

  const setGeneral = useCallback(
    (patch: Partial<GeneralSettings>) => {
      setRaw((prev) => {
        const base = withDefaults(prev)
        return { ...base, general: { ...base.general, ...patch } }
      })
    },
    [setRaw]
  )

  const setMenus = useCallback(
    (patch: Partial<MenuSettings>) => {
      setRaw((prev) => {
        const base = withDefaults(prev)
        return { ...base, menus: { ...base.menus, ...patch } }
      })
    },
    [setRaw]
  )

  const setClaudeCode = useCallback(
    (patch: Partial<ClaudeCodeSettings>) => {
      setRaw((prev) => {
        const base = withDefaults(prev)
        return { ...base, claudeCode: { ...base.claudeCode, ...patch } }
      })
    },
    [setRaw]
  )

  const setSlack = useCallback(
    (patch: Partial<SlackSettings>) => {
      setRaw((prev) => {
        const base = withDefaults(prev)
        return { ...base, slack: { ...base.slack, ...patch } }
      })
    },
    [setRaw]
  )

  const setGmail = useCallback(
    (patch: Partial<GmailSettings>) => {
      setRaw((prev) => {
        const base = withDefaults(prev)
        return { ...base, gmail: { ...base.gmail, ...patch } }
      })
    },
    [setRaw]
  )

  const setFlex = useCallback(
    (patch: Partial<FlexSettings>) => {
      setRaw((prev) => {
        const base = withDefaults(prev)
        return { ...base, flex: { ...base.flex, ...patch } }
      })
    },
    [setRaw]
  )

  const setCowork = useCallback(
    (patch: Partial<CoworkSettings>) => {
      setRaw((prev) => {
        const base = withDefaults(prev)
        return { ...base, cowork: { ...base.cowork, ...patch } }
      })
    },
    [setRaw]
  )

  const setPet = useCallback(
    (patch: Partial<PetSettings>) => {
      setRaw((prev) => {
        const base = withDefaults(prev)
        return { ...base, pet: { ...base.pet, ...patch } }
      })
    },
    [setRaw]
  )

  const value = useMemo(
    () => ({
      settings,
      setGeneral,
      setMenus,
      setClaudeCode,
      setSlack,
      setGmail,
      setFlex,
      setCowork,
      setPet,
    }),
    [
      settings,
      setGeneral,
      setMenus,
      setClaudeCode,
      setSlack,
      setGmail,
      setFlex,
      setCowork,
      setPet,
    ]
  )

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  )
}
