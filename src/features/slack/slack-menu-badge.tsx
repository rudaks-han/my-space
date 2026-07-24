import { SidebarMenuBadge } from "@/components/ui/sidebar"

import { useSlack } from "./use-slack"

/** 사이드바 Slack 메뉴에 붙는 안 읽은 메시지 개수 배지. 0건이면 표시하지 않는다. */
export function SlackMenuBadge() {
  const { channels } = useSlack()
  const total = channels.reduce((sum, c) => sum + c.unread, 0)
  if (total === 0) return null

  const hasMore = channels.some((c) => c.has_more)
  const label = total > 99 ? "99+" : `${total}${hasMore ? "+" : ""}`

  // 빨간 알림 배지 + 흰 글자. text-white! 로 강제해, 메뉴가 활성/hover 일 때
  // SidebarMenuBadge 가 씌우는 peer-data-active/peer-hover 글자색(어두운색)에
  // 덮여 안 보이던 문제를 막는다(라이트·다크 모드 모두 흰 글자 유지).
  return (
    <SidebarMenuBadge className="bg-red-500 font-semibold text-white! shadow-sm peer-hover/menu-button:text-white! peer-data-active/menu-button:text-white!">
      {label}
    </SidebarMenuBadge>
  )
}
