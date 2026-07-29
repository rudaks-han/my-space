import { PanelLeftIcon, SearchIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

interface TitleBarProps {
  /** 중앙 검색 알약 클릭 → 사이드바를 메뉴 검색 컨테이너로 전환. */
  onOpenSearch: () => void
  /** 사이드바 토글(레이아웃 컨트롤). */
  onToggleSidebar: () => void
}

/**
 * Slack 상단바(40px).
 *
 * 라벤더 크롬 색 위에 진한 자주 글자를 쓰고, 중앙에는 Slack 처럼 검색 알약을 둔다.
 * macOS 는 `titleBarStyle: "Overlay"` 라 콘텐츠가 창 맨 위까지 올라온다 — 좌측 78px 는
 * 신호등 버튼 자리로 비워 두고, 바 전체를 창 드래그 핸들(`data-tauri-drag-region`)로 쓴다.
 * 버튼에는 드래그 속성을 주지 않는다(주면 클릭이 먹힌다).
 * 테마 토글은 Slack 의 달 아이콘처럼 좌측 레일 하단(activity-bar)으로 옮겼다.
 */
export function TitleBar({ onOpenSearch, onToggleSidebar }: TitleBarProps) {
  return (
    <header
      data-tauri-drag-region
      className="relative flex h-(--ui-titlebar-h) shrink-0 items-center bg-ui-chrome pr-2 pl-[78px] text-ui-chrome-fg select-none"
    >
      {/* 중앙 검색 알약 — Slack 의 "Search …" 자리. 드래그 영역으로 만들지 않는다. */}
      <button
        type="button"
        aria-label="메뉴 검색"
        onClick={onOpenSearch}
        className="absolute left-1/2 flex h-7 w-[min(420px,45%)] -translate-x-1/2 cursor-pointer items-center gap-2 rounded-full border border-ui-chrome-fg/20 bg-ui-chrome-hover px-3 text-[13px] text-ui-chrome-muted-fg transition-colors hover:bg-ui-chrome-active"
      >
        <SearchIcon className="size-3.5 shrink-0" />
        <span className="truncate">My Space 검색</span>
      </button>

      <div className="ml-auto flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 cursor-pointer rounded-lg hover:bg-ui-chrome-hover"
                aria-label="사이드바 토글"
                onClick={onToggleSidebar}
              >
                <PanelLeftIcon className="size-4" />
              </Button>
            }
          />
          <TooltipContent>사이드바 토글</TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}
