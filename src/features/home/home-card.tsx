import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { useNavigate } from "@/lib/use-navigation"

/**
 * 홈 화면 카드 공통 껍데기 — 제목·아이콘·건수 배지·"전체 보기" 링크를 통일한다.
 * 카드 내용(children)만 각 카드에서 그리면 되고, menuId 를 주면 해당 메뉴로 이동하는
 * 링크가 오른쪽 위에 붙는다.
 */
export function HomeCard({
  icon: Icon,
  title,
  count,
  menuId,
  moreLabel = "전체 보기",
  tone = "default",
  action,
  className,
  children,
}: {
  icon: LucideIcon
  title: string
  /** 0보다 크면 제목 옆에 배지로 표시. */
  count?: number
  /** 클릭 시 이동할 사이드바 메뉴 id. */
  menuId?: string
  moreLabel?: string
  /** alert 면 강조 테두리(확인이 필요한 카드). */
  tone?: "default" | "alert"
  /** "전체 보기" 대신 넣을 커스텀 액션. */
  action?: ReactNode
  className?: string
  children: ReactNode
}) {
  const navigate = useNavigate()
  return (
    <Card
      size="sm"
      className={cn(
        "gap-0",
        tone === "alert" && "ring-2 ring-amber-500/40",
        className
      )}
    >
      <div className="flex items-center gap-2 border-b px-(--card-spacing) pb-3">
        <Icon
          className={cn(
            "size-4 shrink-0",
            tone === "alert"
              ? "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground"
          )}
        />
        <span className="truncate font-heading text-sm font-medium">
          {title}
        </span>
        {count != null && count > 0 && (
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
              tone === "alert"
                ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                : "bg-muted text-muted-foreground"
            )}
          >
            {count}
          </span>
        )}
        <div className="ml-auto shrink-0">
          {action ??
            (menuId && (
              <button
                type="button"
                onClick={() => navigate(menuId)}
                className="cursor-pointer text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {moreLabel} →
              </button>
            ))}
        </div>
      </div>
      <div className="px-(--card-spacing) pt-3">{children}</div>
    </Card>
  )
}

/** 카드 안의 "없음" 상태 문구. */
export function HomeEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>
  )
}
