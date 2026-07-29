import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

import { cn } from "@/lib/utils"
import { useNavigate } from "@/lib/use-navigation"

/**
 * 홈 화면 카드 공통 껍데기 — 제목·아이콘·건수 배지·"전체 보기" 링크를 통일한다.
 * Slack 패널처럼 10px 라운드 + 부드러운 그림자로 띄우고, 헤더는 배경을 칠하지 않고
 * 1px 밑줄로만 본문과 나눈다(제목은 15px semibold, 대문자 아님).
 * 본문(children)만 각 카드에서 그린다. menuId 를 주면 해당 메뉴로 이동하는 링크가
 * 오른쪽 위에 붙는다.
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
    <div
      className={cn(
        "flex flex-col rounded-[10px] border border-border bg-card text-card-foreground shadow-[0_1px_3px_rgba(0,0,0,0.06)]",
        // 확인이 필요한 카드는 경고색 테두리로만 구분한다.
        tone === "alert" && "border-ui-warning",
        className
      )}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <Icon
          className={cn(
            "size-4 shrink-0",
            tone === "alert" ? "text-ui-warning" : "text-muted-foreground"
          )}
        />
        <span className="truncate text-[15px] font-semibold">{title}</span>
        {count != null && count > 0 && (
          <span
            className={cn(
              "flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-2 text-[11px] font-bold tabular-nums",
              tone === "alert"
                ? "bg-ui-warning/20 text-ui-warning"
                : "bg-ui-badge text-ui-badge-fg"
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
                className="cursor-pointer text-[13px] font-semibold text-ui-link hover:underline"
              >
                {moreLabel} →
              </button>
            ))}
        </div>
      </div>
      {/*
       * 본문 여백은 8px 만 준다 — 리스트 행이 자기 px-3 를 갖고 8px 라운드 알약으로
       * hover 되므로, Slack 사이드바처럼 알약이 카드 안쪽 8px 지점부터 시작한다.
       */}
      <div className="p-2">{children}</div>
    </div>
  )
}

/** 카드 안의 "없음" 상태 문구. */
export function HomeEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="py-8 text-center text-[15px] text-muted-foreground">
      {children}
    </p>
  )
}
