import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react"

import { useLocalStorage } from "@/lib/use-local-storage"

/** Claude Code 관련 설정. */
export interface ClaudeCodeSettings {
  /**
   * 작업 감시 on/off. herdr 작업 상태를 주기적으로 폴링해 작업목록 실시간 갱신·
   * 트레이 팝오버 질문·완료/대기 알림을 구동한다. 끄면 이 모든 실시간 동작이 멈춘다.
   */
  watchEnabled: boolean
  /** 입력 대기(AskUserQuestion·권한 프롬프트) 진입 시 인앱 알림(토스트) 표시. */
  notifyOnBlocked: boolean
  /** 작업이 끝났을 때(진행 중 → 완료/대기) 인앱 알림(토스트) 표시. */
  notifyOnDone: boolean
}

/** Slack 관련 설정. */
export interface SlackSettings {
  /** 안 읽은 메시지 자동 새로고침(폴링) 주기(초). */
  pollSeconds: number
}

/**
 * 앱 전체 설정.
 * ★ 설정 카테고리 추가 지점 ★ — 새 카테고리는 여기에 필드를 추가하고
 * DEFAULT_SETTINGS 에 기본값을, settings-view.tsx 의 CATEGORIES 에 화면을 추가한다.
 */
export interface AppSettings {
  claudeCode: ClaudeCodeSettings
  slack: SlackSettings
}

export const DEFAULT_SETTINGS: AppSettings = {
  claudeCode: {
    watchEnabled: true,
    notifyOnBlocked: true,
    notifyOnDone: true,
  },
  slack: {
    pollSeconds: 120,
  },
}

/** 설정 저장 키. */
const STORAGE_KEY = "myspace.settings"

/**
 * 저장된 값에 기본값을 병합한다. 앱 버전이 올라가 새 설정 키가 생겨도(오래된 저장값에
 * 그 키가 없어도) 항상 완전한 설정 객체를 얻도록 카테고리별로 얕은 병합한다.
 */
function withDefaults(
  stored: Partial<AppSettings> | null | undefined
): AppSettings {
  return {
    claudeCode: {
      ...DEFAULT_SETTINGS.claudeCode,
      ...(stored?.claudeCode ?? {}),
    },
    slack: { ...DEFAULT_SETTINGS.slack, ...(stored?.slack ?? {}) },
  }
}

interface SettingsContextValue {
  settings: AppSettings
  /** Claude Code 설정 일부를 갱신한다. */
  setClaudeCode: (patch: Partial<ClaudeCodeSettings>) => void
  /** Slack 설정 일부를 갱신한다. */
  setSlack: (patch: Partial<SlackSettings>) => void
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

/**
 * 설정 상태(localStorage)를 앱 전역에 공유한다. 설정 화면과 알림 로직이 같은 값을
 * 봐야 하므로(토글하면 즉시 반영되도록) Context 로 공유한다.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [raw, setRaw] = useLocalStorage<Partial<AppSettings>>(
    STORAGE_KEY,
    DEFAULT_SETTINGS
  )

  const settings = useMemo(() => withDefaults(raw), [raw])

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

  const value = useMemo(
    () => ({ settings, setClaudeCode, setSlack }),
    [settings, setClaudeCode, setSlack]
  )

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext)
  if (!ctx) {
    throw new Error(
      "useSettings 는 SettingsProvider 안에서만 사용할 수 있습니다."
    )
  }
  return ctx
}
