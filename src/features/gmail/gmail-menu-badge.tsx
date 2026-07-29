import { useGmail } from "./use-gmail"

/**
 * 사이드바 Gmail 메뉴 배지.
 * - 빨강: 안 읽은 "관심" 메일 수(설정 → Gmail 의 발신자·키워드).
 * - 회색(외곽선): 받은편지함 전체의 안 읽은 메일 수.
 * 둘 다 0이면 표시하지 않는다. 회색 배지는 현재 글자색을 따라(선택된 행 위에서도 대비 유지).
 */
export function GmailMenuBadge() {
  const { unreadInterest, totalUnread } = useGmail()
  if (unreadInterest === 0 && totalUnread === 0) return null

  return (
    <span className="ml-auto flex items-center gap-1">
      {unreadInterest > 0 && (
        <span className="min-w-5 rounded-full bg-ui-error px-1.5 text-center text-[11px] leading-5 font-bold text-white tabular-nums">
          {unreadInterest > 99 ? "99+" : unreadInterest}
        </span>
      )}
      {totalUnread > 0 && (
        <span className="min-w-5 rounded-full border border-current/30 px-1.5 text-center text-[11px] leading-5 font-bold tabular-nums opacity-70">
          {totalUnread > 99 ? "99+" : totalUnread}
        </span>
      )}
    </span>
  )
}
