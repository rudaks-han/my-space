import { createContext, useContext } from "react"

/** 한 번(특정 일시) 또는 매일(특정 시각) 반복. */
export type ReminderRepeat = "once" | "daily"

export interface Reminder {
  id: string
  title: string
  repeat: ReminderRepeat
  /** repeat="once": 예정 시각(epoch ms). */
  at: number
  /** repeat="daily": 예정 시각 "HH:MM"(24시간제). */
  time: string
  /** repeat="daily": 주말(토·일)에는 발생하지 않는다. */
  excludeWeekends: boolean
  /** 켜짐/꺼짐. 꺼지면 발생하지 않는다. */
  enabled: boolean
  /** repeat="once": 발생 시각(중복 방지). null 이면 아직 미발생. */
  firedAt: number | null
  /** repeat="daily": 마지막 발생 날짜 "YYYY-MM-DD"(하루 1회 보장). */
  lastFired: string | null
  createdAt: number
}

export interface NewReminderInput {
  title: string
  repeat: ReminderRepeat
  /** once: datetime-local 값(예 "2026-07-22T14:30"). */
  at?: string
  /** daily: "HH:MM". */
  time?: string
  /** daily: 주말 제외 여부. */
  excludeWeekends?: boolean
}

/**
 * 등록된 알림에서 고칠 수 있는 필드. 지정한 값만 바뀐다(반복 종류는 바꾸지 않는다).
 * 시간(at/time)을 바꾸면 발생 여부가 새 시각 기준으로 다시 계산돼 재무장된다.
 */
export interface ReminderPatch {
  /** 알림 이름. */
  title?: string
  /** once: datetime-local 값. */
  at?: string
  /** daily: "HH:MM". */
  time?: string
  /** daily: 주말 제외 여부. */
  excludeWeekends?: boolean
}

export interface ReminderContextValue {
  reminders: Reminder[]
  add: (input: NewReminderInput) => void
  update: (id: string, patch: ReminderPatch) => void
  toggle: (id: string) => void
  remove: (id: string) => void
}

export const ReminderContext = createContext<ReminderContextValue | null>(null)

/** 알림 상태·조작을 제공하는 훅. `ReminderProvider` 안에서만 쓸 수 있다. */
export function useReminders() {
  const ctx = useContext(ReminderContext)
  if (!ctx) {
    throw new Error(
      "useReminders 는 ReminderProvider 안에서만 사용할 수 있습니다."
    )
  }
  return ctx
}
