import { SettingsIcon } from "lucide-react"

import { UnsupportedView } from "@/components/shell/unsupported-view"
import { DevDarkToggle } from "@/features/cowork-dev/dev-dark-store"
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
 * 화면 id → 뷰 헤더의 제목 **옆**에 붙는 버튼. 없으면 null.
 *
 * 여기 있는 이유는 하나다 — 메인 창의 탭 바와 팝아웃 창이 각자 헤더를 그리므로, 화면별
 * 버튼을 양쪽에 따로 적으면 한쪽만 고쳐진다. 셸이 특정 화면을 `if` 로 아는 것도 막는다
 * (그 판단은 이 레지스트리 하나에 모여 있다 — 아이콘·제목·그룹과 같은 자리다).
 *
 * 헤더 **오른쪽**의 "새 창으로 열기" 와 달리 제목 옆에 두는 것은, 이 버튼이 창을 다루는
 * 동작이 아니라 **그 화면의 상태**라서다.
 */
export function viewHeaderAction(id: string) {
  if (id === "cowork-dev") return <DevDarkToggle />
  return null
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
