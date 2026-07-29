import { useEffect, useState } from "react"
import { listen } from "@tauri-apps/api/event"

import { isTauri, trackedInvoke } from "@/lib/tauri"

/*
 * 펫의 빠른 이동 다이얼에 붙일 "안 읽은 건수"(Slack 메시지, Gmail 메일 …).
 *
 * 왜 이런 다리를 놓나: Slack·Gmail 폴링은 메인 창의 SlackProvider / GmailProvider 가
 * 이미 돌린다. 펫 창에 같은 Provider 를 또 두면 폴링이 두 배가 되고, 토큰·연결 상태도
 * 두 벌이 된다. 그래서 메인 창이 결과를 넘겨 주고 펫 창은 받아 쓰기만 한다.
 *
 * ⚠️ 전달을 **Rust 를 거쳐** 한다(localStorage + `storage` 이벤트가 아니다).
 * localStorage 로 하면 창이 뜬 순서에 걸린다 — 펫 창이 먼저 떠서 빈 값을 읽으면 그 뒤의
 * 갱신을 받지 못한 채 0 으로 남을 수 있다. Rust 가 상태를 들고 모든 창에 방출하는 방식은
 * herdr 알림에서 이미 쓰는 경로라(펫의 동작 표시가 그걸로 돌아간다) 확실하다.
 * 콜드 로드로 이벤트를 놓쳐도 마운트 시 한 번 조회해 채운다.
 *
 * ★ 항목 추가 지점 ★ — 다른 알림(Jira, 캘린더 …)을 넣고 싶으면 PetFeedPublisher 에서
 * 그 스토어를 읽어 항목을 하나 더 push 하면 된다. 펫 쪽은 손댈 필요가 없다.
 */

/** 메뉴 하나에 붙일 뱃지 숫자(Rust `PetFeedItem` 과 대응). */
export interface PetFeedItem {
  /** `menus.tsx` 의 메뉴 id. */
  menuId: string
  count: number
}

/** 마지막으로 보낸 값 — 같은 값을 반복해서 보내지 않기 위한 표시. */
let lastSent = ""

/**
 * 안읽음 건수를 Rust 에 넘긴다(메인 창에서만 호출).
 * 값이 그대로면 보내지 않는다 — 폴링마다 모든 창에 이벤트가 날아가면 낭비다.
 */
export function publishPetFeed(items: PetFeedItem[]): void {
  if (!isTauri()) return
  const raw = JSON.stringify(items)
  if (raw === lastSent) return
  lastSent = raw
  void trackedInvoke("pet_set_feed", { items }).catch(() => {
    // 실패하면 다음 변화에 다시 시도되도록 표시를 지운다.
    lastSent = ""
  })
}

/**
 * "메뉴 id → 건수" 로 구독한다(펫 창에서 사용). 다이얼 아이콘의 뱃지가 이 값을 쓴다.
 */
export function usePetFeedCounts(): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({})

  useEffect(() => {
    if (!isTauri()) return

    const apply = (items: PetFeedItem[] | null) => {
      const out: Record<string, number> = {}
      for (const f of items ?? []) {
        // 같은 메뉴에 항목이 여러 개 와도 합쳐 하나의 뱃지로 보여 준다.
        out[f.menuId] = (out[f.menuId] ?? 0) + f.count
      }
      setCounts(out)
    }

    // 창이 막 떠서 이벤트를 놓쳤을 수 있으므로 현재 값을 한 번 조회한다.
    void trackedInvoke<PetFeedItem[]>("pet_feed").then(apply, () => {})
    const unlisten = listen<PetFeedItem[]>("pet:feed", (e) => apply(e.payload))
    return () => void unlisten.then((f) => f())
  }, [])

  return counts
}
