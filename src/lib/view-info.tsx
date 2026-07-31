import { SettingsIcon } from "lucide-react"

import { UnsupportedView } from "@/components/shell/unsupported-view"
import { SettingsView } from "@/features/settings/settings-view"
import { SETTINGS_ID } from "@/lib/use-open-tabs"
import { MENUS, MENU_GROUPS, unsupportedReason } from "@/menus"
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

/**
 * 화면 id → 그릴 뷰. 없는 id 면 첫 메뉴(홈)를 그린다.
 *
 * 이 OS 에서 못 쓰는 메뉴는 뷰 대신 안내 패널로 바꾼다 — 여기가 탭·팝아웃 창이
 * 공유하는 유일한 길목이라, 한 곳만 막으면 실제 뷰가 어디서도 마운트되지 않는다.
 */
export function viewElement(id: string) {
  if (id === SETTINGS_ID) return <SettingsView />
  const menu = MENUS.find((m) => m.id === id) ?? MENUS[0]
  const reason = unsupportedReason(menu)
  if (reason) return <UnsupportedView title={menu.title} reason={reason} />
  return menu.element
}
