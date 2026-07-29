import { useEffect } from "react"

import { isMainWindow } from "@/lib/window-role"
import { useSlack } from "@/features/slack/use-slack"
import { useGmail } from "@/features/gmail/use-gmail"
import { publishPetFeed, type PetFeedItem } from "./pet-feed"

/**
 * 메인 창이 이미 폴링해 둔 안 읽음 건수를 펫이 볼 수 있게 요약해 적는다(무표시 컴포넌트).
 *
 * 메인 창에서만 돈다 — 팝아웃 창까지 적으면 같은 값을 두 창이 번갈아 쓰게 된다.
 * 건수 계산 규칙은 사이드바 배지(`slack-menu-badge` / `gmail-menu-badge`)와 같게 맞춘다.
 * 어긋나면 사이드바와 펫이 다른 숫자를 말하게 된다.
 */
export function PetFeedPublisher() {
  const { channels } = useSlack()
  const { unreadInterest, totalUnread } = useGmail()

  const slackUnread = channels.reduce((sum, c) => sum + c.unread, 0)

  useEffect(() => {
    if (!isMainWindow) return

    const items: PetFeedItem[] = []
    if (slackUnread > 0) items.push({ menuId: "slack", count: slackUnread })
    // Gmail 은 배지와 같은 우선순위 — "관심" 메일이 있으면 그 수를, 없으면 전체 안읽음.
    const gmail = unreadInterest > 0 ? unreadInterest : totalUnread
    if (gmail > 0) items.push({ menuId: "gmail", count: gmail })

    publishPetFeed(items)
  }, [slackUnread, unreadInterest, totalUnread])

  return null
}
