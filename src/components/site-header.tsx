import { useEffect, useState } from "react"
import { MoonIcon, PictureInPicture2Icon, SunIcon } from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { isTauri, trackedInvoke } from "@/lib/tauri"

/**
 * 현재 적용 중인 테마가 다크인지. system 이면 OS 설정을 따르되, 앱 실행 중 OS 외관이
 * 바뀌면(prefers-color-scheme 변경) 토글 아이콘이 즉시 갱신되도록 구독한다.
 */
function useIsDark() {
  const { theme } = useTheme()
  const [systemDark, setSystemDark] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches,
  )

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => setSystemDark(mq.matches)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])

  if (theme === "dark") return true
  if (theme === "light") return false
  return systemDark
}

export function SiteHeader({ title }: { title: string }) {
  const { setTheme } = useTheme()
  const isDark = useIsDark()

  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
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
                  aria-label={isDark ? "라이트 모드로 전환" : "다크 모드로 전환"}
                  onClick={() => setTheme(isDark ? "light" : "dark")}
                >
                  {isDark ? <SunIcon /> : <MoonIcon />}
                </Button>
              }
            />
            <TooltipContent>
              {isDark ? "라이트 모드" : "다크 모드"}
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
