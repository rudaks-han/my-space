import { SettingsIcon } from "lucide-react"

import { SettingsView } from "@/features/settings/settings-view"
import { SETTINGS_ID } from "@/lib/use-open-tabs"
import { MENUS, MENU_GROUPS } from "@/menus"
import type { MenuIcon } from "@/menus"

/** 탭·뷰 헤더·새 창 제목에 쓰는 화면 표시 정보. */
export interface ViewInfo {
  id: string
  title: string
  icon: MenuIcon
  /** 제목 옆에 옅게 붙는 그룹명(사이드바 그룹). */
  group: string
}

/**
 * 화면 id → 표시 정보. 없는 id 면 null(호출부에서 걸러낸다).
 * 설정 화면만 메뉴 목록 밖에 있어 따로 다룬다.
 */
export function viewInfo(id: string): ViewInfo | null {
  if (id === SETTINGS_ID) {
    return { id, title: "설정", icon: SettingsIcon, group: "My Space" }
  }
  const menu = MENUS.find((m) => m.id === id)
  if (!menu) return null
  const group = MENU_GROUPS.find((g) => g.items.some((i) => i.id === id))
  return {
    id,
    title: menu.title,
    icon: menu.icon,
    // label 이 null 인 그룹(general)은 사이드바와 같은 이름으로 표시한다.
    group: group?.label ?? "일반",
  }
}

/** 화면 id → 그릴 뷰. 없는 id 면 첫 메뉴(홈)를 그린다. */
export function viewElement(id: string) {
  if (id === SETTINGS_ID) return <SettingsView />
  return (MENUS.find((m) => m.id === id) ?? MENUS[0]).element
}
