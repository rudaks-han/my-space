import { MoonIcon, PictureInPicture2Icon, SunIcon } from "lucide-react"

import { useIsDark, useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { isTauri, trackedInvoke } from "@/lib/tauri"

export function SiteHeader({ title }: { title: string }) {
  const { setTheme, forcedTheme } = useTheme()
  const { state } = useSidebar()
  const isDark = useIsDark()

  return (
    <header
      // Overlay 타이틀바 아래로 콘텐츠가 들어오므로 헤더를 창 드래그 핸들로 쓴다.
      data-tauri-drag-region
      className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)"
    >
      {/* 사이드바를 접으면 이 헤더가 창 좌상단까지 오므로 신호등 버튼 자리를 비운다. */}
      <div
        className={cn(
          "flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6",
          state === "collapsed" && "pl-20 lg:pl-20"
        )}
      >
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mx-2 h-4 data-vertical:self-auto"
        />
        <h1 className="text-base font-medium">{title}</h1>

        <div className="ml-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={forcedTheme !== undefined}
                  aria-label={
                    forcedTheme
                      ? "현재 테마는 모드가 고정되어 있습니다"
                      : isDark
                        ? "라이트 모드로 전환"
                        : "다크 모드로 전환"
                  }
                  onClick={() => setTheme(isDark ? "light" : "dark")}
                >
                  {isDark ? <SunIcon /> : <MoonIcon />}
                </Button>
              }
            />
            <TooltipContent>
              {forcedTheme
                ? "이 테마는 다크 전용입니다"
                : isDark
                  ? "라이트 모드"
                  : "다크 모드"}
            </TooltipContent>
          </Tooltip>

          {isTauri() && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="미니 아이콘으로 최소화"
                    onClick={() => void trackedInvoke("minimize_to_widget")}
                  >
                    <PictureInPicture2Icon />
                  </Button>
                }
              />
              <TooltipContent>미니 아이콘으로 최소화</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </header>
  )
}
