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
}

export interface ReminderContextValue {
  reminders: Reminder[]
  add: (input: NewReminderInput) => void
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
