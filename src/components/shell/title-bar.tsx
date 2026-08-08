import { PanelLeftIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { EmployeeSearchPalette } from "@/features/gcal/employee-search-palette"
import { MySchedulePalette } from "@/features/gcal/my-schedule-palette"
import { RoomBookingPalette } from "@/features/gcal/room-booking-palette"

interface TitleBarProps {
  /** 사이드바 토글(레이아웃 컨트롤). */
  onToggleSidebar: () => void
}

/**
 * Slack 상단바(40px).
 *
 * 라벤더 크롬 색 위에 진한 자주 글자를 쓰고, 중앙에는 Slack 처럼 알약을 둔다 —
 * 여기서는 내 일정 · 구성원 일정 빠른 검색 · 회의실 예약(사이드바를 접어 둬도 바로 쓴다)이다.
 * macOS 는 `titleBarStyle: "Overlay"` 라 콘텐츠가 창 맨 위까지 올라온다 — 좌측 78px 는
 * 신호등 버튼 자리로 비워 두고, 바 전체를 창 드래그 핸들(`data-tauri-drag-region`)로 쓴다.
 * 버튼에는 드래그 속성을 주지 않는다(주면 클릭이 먹힌다).
 * 테마 토글은 Slack 의 달 아이콘처럼 좌측 레일 하단(activity-bar)으로 옮겼다.
 */
export function TitleBar({ onToggleSidebar }: TitleBarProps) {
  return (
    <header
      data-tauri-drag-region
      className="relative flex h-(--ui-titlebar-h) shrink-0 items-center bg-ui-chrome pr-2 pl-[78px] text-ui-chrome-fg select-none"
    >
      {/* 중앙 알약 세 개 — 내 일정, 구성원 일정 빠른 검색, 회의실 예약. 드래그 영역으로
          만들지 않는다. 각 팔레트가 자기 드롭다운을 띄우므로 여기서는 가로 배치만 잡는다.
          알약 폭은 팔레트마다 고정(150px)이라 이 줄은 내용만큼만 차지한다 — 예전처럼 남는
          폭을 검색 알약에 몰아주면 상단바 절반이 검색창이 된다. */}
      <div className="absolute top-1/2 left-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2">
        <MySchedulePalette />
        <EmployeeSearchPalette />
        <RoomBookingPalette />
      </div>

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
