import { useCallback, useEffect, useRef, type ReactNode } from "react"
import { listen } from "@tauri-apps/api/event"

import { useLocalStorage } from "@/lib/use-local-storage"
import { isTauri, trackedInvoke } from "@/lib/tauri"
import {
  ReminderContext,
  type NewReminderInput,
  type Reminder,
} from "./use-reminders"

/** 알림 저장 키. */
const STORAGE_KEY = "myspace.reminders"
/** 예정 시각 도달 여부 확인 주기(ms). */
const TICK_MS = 15_000

function newId() {
  return crypto.randomUUID()
}

/** 로컬 기준 "YYYY-MM-DD". */
function dateKey(d: Date) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/** "HH:MM" → 오늘 그 시각의 Date. */
function todayAt(time: string, now: Date) {
  const [h, m] = time.split(":").map((n) => parseInt(n, 10))
  const d = new Date(now)
  d.setHours(h || 0, m || 0, 0, 0)
  return d
}

/** 팝오버에 표시할 부제 문구(예정 시각). */
function reminderBody(r: Reminder): string {
  return r.repeat === "daily"
    ? `매일 ${r.time}`
    : new Date(r.at).toLocaleString("ko-KR", {
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
}

/**
 * 알림 상태(localStorage)와 스케줄러를 함께 보유한다.
 * 스케줄러는 앱(메인 창)이 떠 있는 동안 계속 돌며, 예정 시각에 도달하면 Rust
 * `reminder_fire` 를 호출해 트레이 팝오버를 띄운다. 화면 컴포넌트와 스케줄러가
 * 같은 상태를 봐야 하므로(발생 표시가 서로 반영되도록) Context 로 공유한다.
 */
export function ReminderProvider({ children }: { children: ReactNode }) {
  const [reminders, setReminders] = useLocalStorage<Reminder[]>(STORAGE_KEY, [])

  // 항상 최신 목록을 가리키는 ref — 인터벌을 재생성하지 않고 최신 값을 읽는다.
  const remindersRef = useRef(reminders)
  useEffect(() => {
    remindersRef.current = reminders
  }, [reminders])
  // 이번 세션에서 이미 발생 처리한 건(스냅샷 지연으로 인한 중복 발생 방지).
  const firedGuard = useRef<Set<string>>(new Set())
  // 다시 알림(스누즈) 예약: 알림 id → 다시 띄울 시각(epoch ms). 팝오버 창에서 온다.
  const snoozed = useRef<Map<string, number>>(new Map())

  const add = useCallback(
    (input: NewReminderInput) => {
      const title = input.title.trim()
      if (!title) return
      const now = new Date()

      const base = {
        id: newId(),
        title,
        enabled: true,
        firedAt: null as number | null,
        lastFired: null as string | null,
        createdAt: now.getTime(),
      }

      let reminder: Reminder
      if (input.repeat === "daily") {
        const time = input.time || "09:00"
        // 오늘 예정 시각이 이미 지났으면 오늘은 발생 처리로 두어 즉시 울리지 않게 한다.
        const passedToday = now >= todayAt(time, now)
        reminder = {
          ...base,
          repeat: "daily",
          at: 0,
          time,
          lastFired: passedToday ? dateKey(now) : null,
        }
      } else {
        const at = input.at ? new Date(input.at).getTime() : now.getTime()
        reminder = { ...base, repeat: "once", at, time: "" }
      }

      setReminders((prev) => [reminder, ...prev])
    },
    [setReminders],
  )

  const toggle = useCallback(
    (id: string) => {
      setReminders((prev) =>
        prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)),
      )
    },
    [setReminders],
  )

  const remove = useCallback(
    (id: string) => {
      firedGuard.current.delete(id)
      setReminders((prev) => prev.filter((r) => r.id !== id))
    },
    [setReminders],
  )

  // 스케줄러: 예정 시각 도달 시 팝오버 발생.
  useEffect(() => {
    if (!isTauri()) return

    const check = () => {
      const now = new Date()
      const todayKey = dateKey(now)
      // 예정 시각에 도달한 건과, 그 "발생 회차" 키(once=id, daily=id:날짜)를 함께 모은다.
      const due: { reminder: Reminder; occurrence: string }[] = []

      for (const r of remindersRef.current) {
        if (!r.enabled) continue
        if (r.repeat === "once") {
          if (r.firedAt == null && now.getTime() >= r.at) {
            due.push({ reminder: r, occurrence: r.id })
          }
        } else {
          const target = todayAt(r.time, now)
          if (r.lastFired !== todayKey && now >= target) {
            due.push({ reminder: r, occurrence: `${r.id}:${todayKey}` })
          }
        }
      }

      // 이미 이번 세션에 발생 처리한 회차는 제외(스냅샷 지연 중복 방지).
      const fresh = due.filter(({ occurrence }) => !firedGuard.current.has(occurrence))
      if (fresh.length === 0) return
      for (const { occurrence } of fresh) firedGuard.current.add(occurrence)

      // 상태 갱신(발생 표시) — 재시작·재확인에도 중복 발생하지 않도록 영속화한다.
      const firedIds = new Set(fresh.map(({ reminder }) => reminder.id))
      setReminders((prev) =>
        prev.map((r) => {
          if (!firedIds.has(r.id)) return r
          return r.repeat === "once"
            ? { ...r, firedAt: now.getTime() }
            : { ...r, lastFired: todayKey }
        }),
      )

      // 팝오버 발생(여러 건이면 마지막 것이 최종 표시).
      for (const { reminder: r } of fresh) {
        void trackedInvoke("reminder_fire", {
          id: r.id,
          title: r.title,
          body: reminderBody(r),
        }).catch((e) => console.error("reminder_fire 실패:", e))
      }
    }

    // 다시 알림 예약분: 시각이 되면 다시 띄운다. 단, 그 사이 알림이 삭제/비활성화됐다면
    // 예약을 취소한다(원본 상태를 존중 — 삭제된 알림이 다시 뜨지 않도록).
    const checkSnoozed = () => {
      const now = Date.now()
      for (const [id, at] of snoozed.current) {
        if (now < at) continue
        snoozed.current.delete(id)
        const r = remindersRef.current.find((x) => x.id === id)
        if (!r || !r.enabled) continue
        void trackedInvoke("reminder_fire", {
          id: r.id,
          title: r.title,
          body: reminderBody(r),
        }).catch((e) => console.error("reminder_fire 실패:", e))
      }
    }

    check()
    checkSnoozed()
    const timer = setInterval(() => {
      check()
      checkSnoozed()
    }, TICK_MS)
    return () => clearInterval(timer)
  }, [setReminders])

  // 팝오버 창의 "다시 알림"에서 온 스누즈 예약을 받는다.
  useEffect(() => {
    if (!isTauri()) return
    const unlisten = listen<{ id: string; minutes: number }>(
      "reminder:snooze",
      (e) => {
        const { id, minutes } = e.payload
        snoozed.current.set(id, Date.now() + Math.max(1, minutes) * 60_000)
      },
    )
    return () => {
      void unlisten.then((f) => f())
    }
  }, [])

  return (
    <ReminderContext.Provider value={{ reminders, add, toggle, remove }}>
      {children}
    </ReminderContext.Provider>
  )
}
