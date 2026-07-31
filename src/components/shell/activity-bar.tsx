import { FilesIcon, MoonIcon, SettingsIcon, SunIcon } from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { useIsDark, useTheme } from "@/components/theme-provider"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/** 사이드바에 표시할 컨테이너(뷰) 종류. */
export type ActivityContainerId = "explorer"

/** 레일 상단 컨테이너 목록. */
const CONTAINERS: {
  id: ActivityContainerId
  label: string
  icon: LucideIcon
}[] = [{ id: "explorer", label: "탐색기", icon: FilesIcon }]

interface ActivityBarProps {
  /** 현재 선택된 컨테이너. */
  container: ActivityContainerId
  /** 사이드바가 접혀 있는지(접혀 있으면 아무 항목도 활성으로 보이지 않는다). */
  collapsed: boolean
  /** 컨테이너 아이콘 클릭. 활성 컨테이너를 다시 누르면 사이드바가 접힌다. */
  onSelectContainer: (id: ActivityContainerId) => void
  /** 하단 톱니 클릭 → 설정 탭 열기. */
  onOpenSettings: () => void
  /** 설정 탭이 활성인지. */
  settingsActive: boolean
}

/** 레일 하단 아이콘 버튼(라벨 없음) 공통 클래스. */
function railIconClass(active: boolean) {
  return cn(
    "flex size-9 cursor-pointer items-center justify-center rounded-[10px] transition-colors disabled:cursor-default disabled:opacity-50",
    active ? "bg-ui-chrome-active" : "hover:bg-ui-chrome-hover"
  )
}

/**
 * Slack 좌측 레일(64px).
 *
 * 라벤더 크롬 위에 아이콘을 올리고 그 아래 11px 라벨을 붙이는 Slack 레일 구조다.
 * 활성 항목은 아이콘 자리에 둥근 사각 타일이 채워지고 글자가 진해진다(좌측 인디케이터 없음).
 * 하단에는 Slack 의 달 아이콘처럼 테마 토글을 두고, 그 아래 설정을 둔다.
 */
export function ActivityBar({
  container,
  collapsed,
  onSelectContainer,
  onOpenSettings,
  settingsActive,
}: ActivityBarProps) {
  const { setTheme, forcedTheme } = useTheme()
  const isDark = useIsDark()

  return (
    <nav className="flex w-(--ui-activitybar-w) shrink-0 flex-col items-center gap-1 bg-ui-chrome pt-1.5 pb-2 text-ui-chrome-fg select-none">
      {CONTAINERS.map(({ id, label, icon: Icon }) => {
        const active = !collapsed && container === id
        return (
          <Tooltip key={id}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={label}
                  onClick={() => onSelectContainer(id)}
                  className={cn(
                    "group flex w-full cursor-pointer flex-col items-center gap-0.5 py-1.5 transition-colors",
                    active
                      ? "font-semibold text-ui-chrome-fg"
                      : "text-ui-chrome-muted-fg hover:text-ui-chrome-fg"
                  )}
                >
                  <span
                    className={cn(
                      "flex size-9 items-center justify-center rounded-[10px] transition-colors",
                      active
                        ? "bg-ui-chrome-active"
                        : "group-hover:bg-ui-chrome-hover"
                    )}
                  >
                    <Icon className="size-5" />
                  </span>
                  <span className="text-[11px] leading-tight font-medium">
                    {label}
                  </span>
                </button>
              }
            />
            <TooltipContent side="right">{label}</TooltipContent>
          </Tooltip>
        )
      })}

      <div className="mt-auto flex flex-col items-center gap-1">
        {/* 테마 토글 — 프리셋이 모드를 고정한 동안에는 비활성. */}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                disabled={forcedTheme !== undefined}
                aria-label={
                  forcedTheme
                    ? "현재 테마는 모드가 고정되어 있습니다"
                    : isDark
                      ? "라이트 모드로 전환"
                      : "다크 모드로 전환"
                }
                onClick={() => setTheme(isDark ? "light" : "dark")}
                className={railIconClass(false)}
              >
                {isDark ? (
                  <SunIcon className="size-5" />
                ) : (
                  <MoonIcon className="size-5" />
                )}
              </button>
            }
          />
          <TooltipContent side="right">
            {forcedTheme
              ? "이 테마는 다크 전용입니다"
              : isDark
                ? "라이트 모드"
                : "다크 모드"}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="설정"
                onClick={onOpenSettings}
                className={railIconClass(settingsActive)}
              >
                <SettingsIcon className="size-5" />
              </button>
            }
          />
          <TooltipContent side="right">설정</TooltipContent>
        </Tooltip>
      </div>
    </nav>
  )
}
