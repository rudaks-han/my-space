import { useEffect } from "react"

import { isMainWindow } from "@/lib/window-role"
import { useSlack } from "@/features/slack/use-slack"
import { useGmail } from "@/features/gmail/use-gmail"
import { publishPetFeed, type PetFeedItem } from "./pet-feed"

/**
 * 메인 창이 이미 폴링해 둔 안 읽음 건수를 펫이 볼 수 있게 요약해 적는다(무표시 컴포넌트).
 *
 * 메인 창에서만 돈다 — 팝아웃 창까지 적으면 같은 값을 두 창이 번갈아 쓰게 된다.
 * Slack 은 사이드바 배지(`slack-menu-badge`)와 같은 규칙으로 세고, Gmail 은
 * 사이드바의 빨강 배지(관심)만 따른다 — 다이얼 배지는 하나라 전체 안읽음까지 섞을 자리가 없다.
 */
export function PetFeedPublisher() {
  const { channels } = useSlack()
  const { unreadInterest } = useGmail()

  const slackUnread = channels.reduce((sum, c) => sum + c.unread, 0)

  useEffect(() => {
    if (!isMainWindow) return

    const items: PetFeedItem[] = []
    if (slackUnread > 0) items.push({ menuId: "slack", count: slackUnread })
    // Gmail 은 "관심" 메일 수만 센다(설정 → Gmail 의 발신자·키워드).
    // 사이드바는 빨강(관심) + 회색(전체) 두 배지를 나란히 보여 줄 수 있지만
    // 다이얼 배지는 하나뿐이라, 전체 안읽음으로 대체하면 수백 통짜리 숫자가 붙어
    // "지금 볼 것"이라는 신호가 아니라 잡음이 된다. 관심 필터가 비어 있으면 배지 없음.
    if (unreadInterest > 0)
      items.push({ menuId: "gmail", count: unreadInterest })

    publishPetFeed(items)
  }, [slackUnread, unreadInterest])

  return null
}
