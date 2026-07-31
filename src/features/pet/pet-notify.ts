import { useEffect, useState } from "react"
import { listen } from "@tauri-apps/api/event"

import { isTauri, trackedInvoke } from "@/lib/tauri"

/*
 * 앱 알림(Gmail 새 메일 · Slack 새 메시지 · 캘린더 일정)을 펫 말풍선에 띄우는 통로.
 *
 * herdr·리마인더 알림은 Rust 가 만들지만 이 셋은 **메인 창이 만든다** — 폴링과 판정(새
 * 메일인지, 일정 10분 전인지)이 이미 메인 창에 있고, Rust 로 옮기면 같은 API 를 두 벌
 * 호출하게 된다. 그래도 전달은 Rust 를 거친다(뱃지 건수 `pet-feed.ts` 와 같은 이유):
 * 펫 창은 숨어 있다 뒤늦게 뜰 수 있어 마운트 시 현재 목록을 조회할 곳이 필요하고,
 * 펫을 꺼 뒀을 때 "잠깐 띄우기" 판단도 Rust(`pet::set_alert`)가 한다.
 *
 * 표시 시간(TTL)은 **넣은 쪽이 센다** — `notifyPet` 이 설정된 시간 뒤에 스스로 치운다.
 * 리마인더가 메인 창 스케줄러로 도는 것과 같은 구조다(Rust 에 타이머를 두지 않는다).
 */

/** 펫 말풍선에 띄울 앱 알림 한 건(Rust `AppNotice` 와 대응). */
export interface AppNotice {
  /**
   * 중복 방지·닫기 매칭용 id. 출처와 원본 식별자로 만든다
   * (`gmail:<메시지 id>`, `slack:<채널>:<ts>`, `gcal:before:<시작시각>` …) —
   * 같은 알림을 두 번 띄우지 않으려면 같은 원본이 항상 같은 id 여야 한다.
   */
  id: string
  /** 출처 — 말풍선의 아이콘·이름이 이 값으로 갈린다. */
  source: AppNoticeSource
  /** 상태 칩 문구("새 메일", "10분 전" …). */
  chip: string
  /** 굵은 첫 줄(메일 제목·채널 이름·일정 이름). */
  title: string
  /** 옅은 둘째 줄. 없으면 빈 문자열. */
  body: string
  /** 눌렀을 때 열 메뉴 id(`menus.tsx`). 비어 있으면 메인 창만 띄운다. */
  menuId: string
}

/** 앱 알림의 출처 — `menus.tsx` 의 메뉴 id 와 같은 값을 쓴다(아이콘을 그대로 재사용). */
export type AppNoticeSource = "gmail" | "slack" | "gcal"

/**
 * 알림 하나를 펫에 띄우고, `ttlMs` 뒤에 스스로 치운다(`ttlMs <= 0` = 치울 때까지 표시).
 *
 * 타이머를 컴포넌트가 아니라 여기서 들고 있는 이유: 알림을 만든 화면이 리렌더돼도
 * 표시 시간은 그대로여야 한다. 이미 사용자가 눌러 치운 알림을 다시 치우는 건 무해하다
 * (Rust 쪽에서 없는 id 는 무시된다).
 */
export function notifyPet(notice: AppNotice, ttlMs: number): void {
  if (!isTauri()) return
  void trackedInvoke("pet_notify", { notice }).catch((e) =>
    console.error("pet_notify 실패:", e)
  )
  if (ttlMs > 0) {
    setTimeout(() => dismissPetNotice(notice.id), ttlMs)
  }
}

/** 알림 하나를 치운다(표시 시간 만료, 또는 말풍선을 눌러 그 메뉴로 이동했을 때). */
export function dismissPetNotice(id: string): void {
  if (!isTauri()) return
  void trackedInvoke("pet_dismiss_notice", { id }).catch(() => {
    // 치우기 실패는 조용히 넘긴다 — 다음 알림이 오거나 사용자가 누르면 다시 정리된다.
  })
}

/** 지금 떠 있는 앱 알림들을 구독한다(펫 창에서 사용). */
export function useAppNotices(): AppNotice[] {
  const [notices, setNotices] = useState<AppNotice[]>([])

  useEffect(() => {
    if (!isTauri()) return
    // 창이 막 떠서 이벤트를 놓쳤을 수 있으므로 현재 목록을 한 번 조회한다.
    void trackedInvoke<AppNotice[]>("pet_notices").then(
      (list) => setNotices(list ?? []),
      () => {}
    )
    const unlisten = listen<AppNotice[]>("pet:notices", (e) =>
      setNotices(e.payload ?? [])
    )
    return () => void unlisten.then((f) => f())
  }, [])

  return notices
}
