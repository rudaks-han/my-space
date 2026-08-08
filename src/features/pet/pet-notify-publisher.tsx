import { useEffect, useRef } from "react"

import { trackedInvoke } from "@/lib/tauri"
import { isMainWindow } from "@/lib/window-role"
import { useSettings } from "@/features/settings/settings-context"
import { useSlack, type ChannelUnread } from "@/features/slack/use-slack"
import { useGmail, matchesInterest } from "@/features/gmail/use-gmail"
import type { CalendarEvent } from "@/features/gcal/use-gcal"
import { notifyPet, dismissPetNotice, type AppNotice } from "./pet-notify"

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

/**
 * 그 메시지가 여전히 "안 읽음" 인가. 안 읽은 목록에 있으면 당연히 안 읽음이고, 없을 때는
 * 목록이 잘렸을 가능성(`has_more` — 안 읽은 게 많으면 일부만 가져온다)을 감안해 **가져온
 * 범위 안인지**로 가른다: 잘려서 빠지는 것은 항상 가장 오래된 쪽이므로, 남아 있는 것보다
 * 더 오래된 메시지는 "읽었다"고 단정하지 않고 판단을 미룬다.
 *
 * 채널이 목록에서 아예 빠졌으면 그 채널에 안 읽은 메시지가 없다(또는 감시 대상에서
 * 제외됐다) — 어느 쪽이든 알림을 남겨 둘 이유가 없다.
 *
 * ⚠️ DM 은 개수가 많아 Rust 가 **회전하며 나눠 확인**하므로 "이번 응답에 없다"가 곧
 * "확인했는데 없다"는 아니다. 그런데도 이 판정이 성립하는 것은 Rust 가 **지난번 안 읽음이
 * 있던 대화(`hot`)를 회전과 무관하게 매번 확인**하기 때문이다. 즉 알림이 떠 있는 DM 은
 * 항상 확인 대상이라, 응답에서 빠졌다면 정말로 읽힌 것이다. 그 규칙(slack.rs 의 `DmScan`)을
 * 없애면 아직 안 읽은 DM 알림이 다음 주기에 조용히 사라진다.
 */
function stillUnread(c: ChannelUnread | undefined, ts: string): boolean {
  if (!c || !c.messages.length) return false
  if (c.messages.some((m) => m.ts === ts)) return true
  const at = Number(ts)
  // ts 를 숫자로 읽을 수 없으면(형식이 바뀌었다면) 지우지 않는다 — 안 읽은 알림을 조용히
  // 없애는 쪽이 남겨 두는 쪽보다 나쁘다.
  if (!Number.isFinite(at)) return true
  return at < Math.min(...c.messages.map((m) => Number(m.ts)))
}

/** 새 Slack 메시지 알림 — 선택한 채널의 안 읽은 메시지 목록에서 새것만 고른다. */
function useSlackNotices(enabled: boolean, ttlMs: number) {
  const { channels, error } = useSlack()
  const { seenRef, seededRef } = useSeenIds(enabled)
  /**
   * 아직 말풍선에 떠 있을 수 있는 알림 id → 원본 메시지. 사용자가 Slack 에서 직접 읽으면
   * 다음 폴링의 안 읽은 목록에서 그 메시지가 빠지므로, 그때 알림도 같이 치우려고 들고 있다.
   * `seenRef` 로 대신할 수 없다 — 그쪽은 "다시 알리지 않기" 표시라 치운 뒤에도 남아야 한다.
   */
  const liveRef = useRef<Map<string, { channel: string; ts: string }>>(
    new Map()
  )

  useEffect(() => {
    // 알림을 껐으면 추적도 멈춘다(남은 알림은 표시 시간이 지나며 사라진다).
    if (!enabled) liveRef.current.clear()
  }, [enabled])

  useEffect(() => {
    if (!isMainWindow || !enabled) return

    /*
     * 사용자가 Slack 에서 직접 읽은 메시지의 알림을 치운다 — 이미 확인한 것을 계속 띄워 두면
     * ("항상 표시" 설정이면 시간으로도 사라지지 않는다) 알림이 실제 상태와 어긋난다.
     * 폴링이 실패한 주기(error)에는 목록이 낡았을 수 있어 건드리지 않는다.
     */
    if (!error) {
      for (const [id, m] of [...liveRef.current]) {
        const c = channels.find((c) => c.id === m.channel)
        if (stillUnread(c, m.ts)) continue
        liveRef.current.delete(id)
        dismissPetNotice(id)
      }
    }

    /*
     * 원본(채널·ts)을 알림과 함께 들고 간다 — 뒤에서 `liveRef` 에 넣을 때 id 를 다시 쪼개지
     * 않기 위해서다(만드는 쪽과 읽는 쪽이 각자 문자열을 조립하면 조용히 어긋난다).
     */
    const fresh: { notice: AppNotice; channel: string; ts: string }[] = []
    for (const c of channels) {
      for (const m of c.messages) {
        // ts 는 채널 안에서 유일하다(같은 메시지는 폴링마다 같은 값으로 온다).
        const id = `slack:${c.id}:${m.ts}`
        if (seenRef.current.has(id)) continue
        seenRef.current.add(id)
        fresh.push({
          notice: {
            id,
            source: "slack",
            chip: "새 메시지",
            // 채널 이름을 굵게 — DM·그룹 DM 은 이름 자체가 사람이라 # 를 붙이지 않는다
            // (그룹 DM 이름은 "가, 나, 다" 형태다).
            title:
              c.kind === "channel" || c.kind === "private"
                ? `#${c.name}`
                : c.name,
            body: `${m.user}: ${m.text}`,
            menuId: "slack",
            // Slack 앱으로 바로 갈 수 있게 원본 좌표를 함께 실어 보낸다. 어느 쪽으로
            // 갈지는 누를 때 펫 창이 설정을 보고 정하므로 여기서는 고르지 않는다.
            link: {
              kind: "slack",
              channel: c.id,
              ts: m.ts,
              threadTs: m.thread_ts,
            },
          },
          channel: c.id,
          ts: m.ts,
        })
      }
    }

    if (!seededRef.current) {
      seededRef.current = true
      return
    }

    // 띄운 것만 추적한다 — 배치 상한에 걸려 안 띄운 알림은 치울 것도 없다.
    for (const f of fresh.slice(0, MAX_PER_BATCH)) {
      notifyPet(f.notice, ttlMs)
      liveRef.current.set(f.notice.id, { channel: f.channel, ts: f.ts })
    }
  }, [enabled, channels, error, ttlMs, seenRef, seededRef])
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

    /**
     * 같은 일정·같은 종류로 두 번 알리지 않는다(30초마다 같은 판정을 하므로 필수).
     * 실제로 띄웠을 때만 `true` — 뒤따르는 정리(10분 전 알림 치우기)를 한 번만 하려고.
     */
    const fire = (id: string, chip: string, title: string, body: string) => {
      if (fired.current.has(id)) return false
      fired.current.add(id)
      notifyPet(
        { id, source: "gcal", chip, title, body, menuId: "gcal" },
        ttlMs
      )
      return true
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
          if (
            fire(`gcal:start:${at}:${title}`, "시작", title, `${hhmm} 시작`)
          ) {
            // 같은 일정의 "10분 전" 알림은 할 일을 다했다 — 항상 표시(TTL 0)면 스스로
            // 사라지지 않아 같은 일정 카드가 두 장 쌓인다(TTL 이 있으면 이미 없어져
            // 있고, 없는 id 를 치우는 건 무해하다).
            dismissPetNotice(`gcal:before:${at}:${title}`)
          }
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
