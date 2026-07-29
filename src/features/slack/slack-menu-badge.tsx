import { useSlack } from "./use-slack"

/** 사이드바 Slack 메뉴에 붙는 안 읽은 메시지 개수 배지. 0건이면 표시하지 않는다. */
export function SlackMenuBadge() {
  const { channels } = useSlack()
  const total = channels.reduce((sum, c) => sum + c.unread, 0)
  if (total === 0) return null

  const hasMore = channels.some((c) => c.has_more)
  const label = total > 99 ? "99+" : `${total}${hasMore ? "+" : ""}`

  // Slack 안읽음 배지 톤(빨간 알약 + 흰 굵은 글자). 내비 행 안에서 오른쪽 끝에 붙는다.
  return (
    <span className="ml-auto min-w-5 rounded-full bg-ui-error px-1.5 text-center text-[11px] leading-5 font-bold text-white tabular-nums">
      {label}
    </span>
  )
}
