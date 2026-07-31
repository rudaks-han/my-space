import { CheckIcon, RotateCcwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { MENU_GROUPS, type MenuIcon } from "@/menus"

import { useSettings } from "./settings-context"

/** 패널 머리말: 18px 굵은 제목 + 13px 설명. (settings-view 의 PanelHeader 와 같은 톤) */
function PanelHeader({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="border-b border-border pb-3">
      <h2 className="text-[18px] font-bold tracking-[-0.01em]">{title}</h2>
      <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>
    </div>
  )
}

/** 18px 라운드 사각 체크박스(설정 화면 공통 표현). */
function CheckMark({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        "flex size-[18px] shrink-0 items-center justify-center rounded-[4px] border transition-colors",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-background"
      )}
    >
      {checked && <CheckIcon className="size-3.5" />}
    </span>
  )
}

/**
 * 체크 한 줄. 그룹 줄(`strong`)과 하위 메뉴 줄을 같은 컴포넌트로 그린다 —
 * 사이드바처럼 하위 항목은 들여쓰고, 그룹이 꺼져 있으면 흐리게 보여 준다.
 */
function CheckRow({
  label,
  icon: Icon,
  checked,
  strong,
  dimmed,
  onToggle,
}: {
  label: string
  icon?: MenuIcon
  checked: boolean
  strong?: boolean
  dimmed?: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
      className={cn(
        "flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-ui-list-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid",
        dimmed && "opacity-45"
      )}
    >
      <CheckMark checked={checked} />
      {Icon && <Icon className="size-4 shrink-0" />}
      <span
        className={cn("truncate text-[15px]", strong ? "font-bold" : undefined)}
      >
        {label}
      </span>
    </button>
  )
}

/**
 * 메뉴 설정 화면 — 사이드바에 어떤 그룹·메뉴를 보일지 고른다.
 *
 * 설정에는 **감출 id 만** 저장하므로(`settings.menus`) 기본값은 전부 사용이고,
 * 나중에 `menus.tsx` 에 메뉴가 추가돼도 자동으로 보인다.
 */
export function MenuSettingsPanel() {
  const { settings, setMenus } = useSettings()
  const { hiddenGroups, hiddenItems } = settings.menus

  const toggleGroup = (id: string) => {
    setMenus({
      hiddenGroups: hiddenGroups.includes(id)
        ? hiddenGroups.filter((x) => x !== id)
        : [...hiddenGroups, id],
    })
  }

  const toggleItem = (id: string) => {
    setMenus({
      hiddenItems: hiddenItems.includes(id)
        ? hiddenItems.filter((x) => x !== id)
        : [...hiddenItems, id],
    })
  }

  const hiddenCount = hiddenGroups.length + hiddenItems.length

  return (
    <div className="flex flex-col">
      <PanelHeader
        title="메뉴 설정"
        description="왼쪽 사이드바에 표시할 메뉴를 고릅니다. 기본값은 모두 사용이며, 끈 메뉴만 목록에서 사라집니다. 이미 열려 있는 탭은 닫히지 않고, 홈 화면 카드나 펫의 빠른 이동으로는 여전히 열 수 있습니다."
      />

      <div className="mt-3 flex items-center gap-2">
        <p className="text-[13px] text-muted-foreground">
          {hiddenCount === 0
            ? "모든 메뉴를 사용 중입니다."
            : `${hiddenCount}개를 감추고 있습니다.`}
        </p>
        {hiddenCount > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto shrink-0 rounded-full"
            onClick={() => setMenus({ hiddenGroups: [], hiddenItems: [] })}
          >
            <RotateCcwIcon className="size-3.5" />
            모두 사용으로 되돌리기
          </Button>
        )}
      </div>

      <div className="mt-3 flex flex-col gap-3">
        {MENU_GROUPS.map((g) => {
          const groupOn = !hiddenGroups.includes(g.id)
          return (
            <div
              key={g.id}
              className="rounded-[10px] border border-border p-1.5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
            >
              {/* 라벨이 없는 그룹(general)도 사이드바와 같이 "일반" 으로 부른다. */}
              <CheckRow
                label={g.label ?? "일반"}
                checked={groupOn}
                strong
                onToggle={() => toggleGroup(g.id)}
              />
              <div className="pl-6">
                {g.items.map((m) => (
                  <CheckRow
                    key={m.id}
                    label={m.title}
                    icon={m.icon}
                    checked={!hiddenItems.includes(m.id)}
                    dimmed={!groupOn}
                    onToggle={() => toggleItem(m.id)}
                  />
                ))}
              </div>
              {!groupOn && (
                <p className="px-3 pt-0.5 pb-1.5 text-[13px] text-muted-foreground">
                  그룹을 꺼 두어 하위 메뉴가 모두 표시되지 않습니다.
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
