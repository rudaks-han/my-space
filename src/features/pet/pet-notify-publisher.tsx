import { useEffect, useRef } from "react"

import { trackedInvoke } from "@/lib/tauri"
import { isMainWindow } from "@/lib/window-role"
import { useSettings } from "@/features/settings/settings-context"
import { useSlack } from "@/features/slack/use-slack"
import { useGmail, matchesInterest } from "@/features/gmail/use-gmail"
import type { CalendarEvent } from "@/features/gcal/use-gcal"
import { notifyPet, type AppNotice } from "./pet-notify"

/*
 * Gmail 새 메일 · Slack 새 메시지 · 캘린더 일정을 펫 말풍선 알림으로 바꾸는 무표시 컴포넌트.
 *
 * 메인 창에서만 돈다(팝아웃 창까지 돌면 같은 알림이 두 번 뜬다 — reminder-store 와 같은 이유).
 * Gmail·Slack 은 이미 메인 창이 폴링하는 스토어를 **읽기만** 하고, 캘린더만 자기 폴링을
 * 갖는다(아래 참고).
 *
 * 세 가지 규칙이 공통이다:
 *  1. **처음 본 목록은 알리지 않는다.** 앱을 켤 때 이미 쌓여 있던 안 읽은 메일·메시지를
 *     전부 띄우면 말풍선이 화면을 덮는다 — 첫 스냅샷은 "이미 본 것"으로 표시만 해 둔다.
 *  2. **한 번 알린 것은 다시 알리지 않는다**(id 기준). 폴링이 같은 목록을 계속 돌려주므로
 *     이 표시가 없으면 주기마다 같은 알림이 되살아난다.
 *  3. **한 번에 알리는 개수를 묶는다.** 말풍선은 2장까지만 펼쳐 보여 주고(나머지는
 *     "N개 더 보기"), 20통이 한꺼번에 들어오면 어차피 읽을 수 없다.
 */

/**
 * 한 번에 띄울 알림 최대 개수(출처별). 말풍선은 `MAX_VISIBLE`(2)장만 펼치고 나머지는
 * "N개 더 보기" 로 접으므로, 여기서 더 줄이면 접힌 개수에도 안 잡히고 그냥 사라진다.
 */
const MAX_PER_BATCH = 3

/** 캘린더 일정을 다시 불러오는 주기(5분) — 다른 화면의 일정 폴링과 같은 간격. */
const GCAL_POLL_MS = 300_000

/** 예정 시각 도달을 확인하는 주기(30초). 10분 전 알림이 1분 이상 늦지 않을 정도. */
const GCAL_TICK_MS = 30_000

/** "시작 10분 전" 알림을 띄우는 시점(ms). */
const GCAL_LEAD_MS = 10 * 60_000

/**
 * 시작 알림을 놓친 것으로 보기까지의 여유(ms). 앱을 켠 시점에 이미 지나간 일정까지
 * 알리면(예: 아침에 켰을 때 지난밤 일정) 쓸모없는 알림이 쏟아진다.
 */
const GCAL_GRACE_MS = 2 * 60_000

export function PetNotifyPublisher() {
  const { settings } = useSettings()
  const notify = settings.pet.notify
  /** 알림을 띄워 둘 시간(ms). 0 = 치울 때까지(설정의 "항상 표시"). */
  const ttlMs = Math.max(0, settings.pet.noticeSeconds ?? 12) * 1000

  useGmailNotices(notify.gmail, ttlMs)
  useSlackNotices(notify.slack, ttlMs)
  // 캘린더는 상위 스위치(`gcal`)와 "언제"(정시·10분 전)를 곱해 넘긴다 — 상위를 끄면
  // 고른 시점은 그대로 남고 알림만 멈춘다(다시 켤 때 두 번 고르지 않도록).
  useGcalNotices(
    notify.gcal && notify.gcalBefore,
    notify.gcal && notify.gcalStart,
    ttlMs
  )

  return null
}

/**
 * 이미 알린 항목을 기억하는 표시.
 *
 * `seededRef` 가 false 인 동안(=첫 스냅샷)은 알리지 않고 표시만 남긴다. 설정을 껐다 켜면
 * 다시 false 가 되므로, 켜는 순간 쌓여 있던 것들이 한꺼번에 뜨지 않는다.
 */
function useSeenIds(enabled: boolean) {
  const seenRef = useRef<Set<string>>(new Set())
  const seededRef = useRef(false)

  useEffect(() => {
    if (enabled) return
    // 껐다 켰을 때 그동안 쌓인 것을 몰아 알리지 않도록 표시를 비운다.
    seenRef.current.clear()
    seededRef.current = false
  }, [enabled])

  return { seenRef, seededRef }
}

/** 새 메일 알림 — 사이드바 배지와 같은 받은편지함 스냅샷을 읽는다(폴링을 더 만들지 않는다). */
function useGmailNotices(enabled: boolean, ttlMs: number) {
  const { inbox } = useGmail()
  const { settings } = useSettings()
  const { senders, keywords } = settings.gmail
  const { seenRef, seededRef } = useSeenIds(enabled)

  useEffect(() => {
    if (!isMainWindow || !enabled) return

    /*
     * 관심 필터(설정 → Gmail)가 있으면 관심 메일만 알린다 — 사이드바 배지가 이미 같은
     * 우선순위를 쓰고("관심이 있으면 관심 수, 없으면 전체"), 하루 수백 통이 오는 사서함에서
     * 전부 알리면 알림이 무의미해진다. 필터가 비어 있으면 안 읽은 메일 전부가 대상이다.
     */
    const useFilter = senders.length > 0 || keywords.length > 0
    const fresh = inbox.filter(
      (m) =>
        m.unread &&
        !seenRef.current.has(m.id) &&
        (!useFilter || matchesInterest(m, senders, keywords))
    )
    for (const m of fresh) seenRef.current.add(m.id)

    if (!seededRef.current) {
      // 첫 스냅샷은 "이미 본 것" — 앱을 켤 때 쌓여 있던 메일을 몰아 알리지 않는다.
      seededRef.current = true
      return
    }

    for (const m of fresh.slice(0, MAX_PER_BATCH)) {
      notifyPet(
        {
          id: `gmail:${m.id}`,
          source: "gmail",
          chip: "새 메일",
          title: m.subject || "(제목 없음)",
          body: m.from_name || m.from_email,
          menuId: "gmail",
        },
        ttlMs
      )
    }
  }, [enabled, inbox, senders, keywords, ttlMs, seenRef, seededRef])
}

/** 새 Slack 메시지 알림 — 선택한 채널의 안 읽은 메시지 목록에서 새것만 고른다. */
function useSlackNotices(enabled: boolean, ttlMs: number) {
  const { channels } = useSlack()
  const { seenRef, seededRef } = useSeenIds(enabled)

  useEffect(() => {
    if (!isMainWindow || !enabled) return

    const fresh: AppNotice[] = []
    for (const c of channels) {
      for (const m of c.messages) {
        // ts 는 채널 안에서 유일하다(같은 메시지는 폴링마다 같은 값으로 온다).
        const id = `slack:${c.id}:${m.ts}`
        if (seenRef.current.has(id)) continue
        seenRef.current.add(id)
        fresh.push({
          id,
          source: "slack",
          chip: "새 메시지",
          // 채널 이름을 굵게 — DM 은 이름 자체가 상대이므로 # 를 붙이지 않는다.
          title: c.kind === "im" ? c.name : `#${c.name}`,
          body: `${m.user}: ${m.text}`,
          menuId: "slack",
        })
      }
    }

    if (!seededRef.current) {
      seededRef.current = true
      return
    }

    for (const n of fresh.slice(0, MAX_PER_BATCH)) notifyPet(n, ttlMs)
  }, [enabled, channels, ttlMs, seenRef, seededRef])
}

/**
 * 일정 알림(10분 전 · 정시).
 *
 * 여기만 자기 폴링을 갖는 이유: `useGcal()` 의 주기 새로고침은 **그 탭이 보일 때만** 돈다
 * (keep-alive 탭이 전부 폴링하지 않도록). 캘린더 탭을 열어 두지 않으면 일정이 갱신되지
 * 않으므로, 시각에 걸린 알림을 그 훅에 얹을 수 없다. 대신 이 폴링은 알림을 켜 뒀을 때만
 * 돌고 5분에 한 번이라 부담이 없다.
 */
function useGcalNotices(before: boolean, start: boolean, ttlMs: number) {
  const enabled = before || start
  const events = useRef<CalendarEvent[]>([])
  /** 이미 띄운 알림 id — 30초마다 같은 판정을 하므로 이게 없으면 계속 되살아난다. */
  const fired = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!isMainWindow || !enabled) return

    const load = () => {
      void trackedInvoke<CalendarEvent[]>("gcal_today")
        .then((list) => {
          events.current = list ?? []
        })
        .catch(() => {
          // 연결 안 됨·일시적 실패 — 다음 주기에 다시 시도한다(알림은 부가 기능이라 조용히).
        })
    }

    /** 같은 일정·같은 종류로 두 번 알리지 않는다(30초마다 같은 판정을 하므로 필수). */
    const fire = (id: string, chip: string, title: string, body: string) => {
      if (fired.current.has(id)) return
      fired.current.add(id)
      notifyPet(
        { id, source: "gcal", chip, title, body, menuId: "gcal" },
        ttlMs
      )
    }

    const check = () => {
      const now = Date.now()
      for (const e of events.current) {
        // 종일 일정은 시작 시각이 없어 "10분 전"이 성립하지 않는다.
        if (e.all_day) continue
        const at = new Date(e.start).getTime()
        if (!Number.isFinite(at)) continue

        const title = e.summary || "(제목 없음)"
        const hhmm = new Date(at).toLocaleTimeString("ko-KR", {
          hour: "numeric",
          minute: "2-digit",
        })

        // 10분 전: 창이 열려 있는 구간(시작 10분 전 ~ 시작)에서만.
        if (before && now >= at - GCAL_LEAD_MS && now < at) {
          fire(`gcal:before:${at}:${title}`, "10분 전", title, `${hhmm} 시작`)
        }
        // 정시: 시작 직후 잠깐만. 이미 지난 일정까지 알리면 앱을 켤 때마다 쏟아진다.
        if (start && now >= at && now < at + GCAL_GRACE_MS) {
          fire(`gcal:start:${at}:${title}`, "시작", title, `${hhmm} 시작`)
        }
      }
    }

    load()
    check()
    const poll = setInterval(load, GCAL_POLL_MS)
    const tick = setInterval(check, GCAL_TICK_MS)
    return () => {
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [enabled, before, start, ttlMs])
}
