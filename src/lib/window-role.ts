import { getCurrentWindow } from "@tauri-apps/api/window"

import { isTauri } from "@/lib/tauri"

/**
 * 메뉴를 "새 창으로 열기"로 띄운 창의 라벨 접두사(`view-<메뉴 id>`).
 * lib.rs 의 VIEW_WINDOW_PREFIX, capabilities/default.json 의 `view-*` 와 같아야 한다.
 */
export const VIEW_WINDOW_PREFIX = "view-"

/**
 * 데스크톱 펫(상시 표시 캐릭터) 창의 라벨.
 * pet.rs 의 LABEL, capabilities/default.json 의 `pet` 과 같아야 한다.
 */
export const PET_WINDOW_LABEL = "pet"

/** 이 코드가 돌고 있는 창의 라벨. 브라우저(비 Tauri)에서는 메인 창처럼 취급한다. */
export const WINDOW_LABEL = isTauri() ? getCurrentWindow().label : "main"

/** 셸(사이드바·탭)을 그리는 본 창인지. 스케줄러·이력 기록 같은 전역 동작은 여기서만 돈다. */
export const isMainWindow = WINDOW_LABEL === "main"

/** 메뉴 하나만 띄운 새 창인지. */
export const isViewWindow = WINDOW_LABEL.startsWith(VIEW_WINDOW_PREFIX)

/** 데스크톱 펫 창인지. */
export const isPetWindow = WINDOW_LABEL === PET_WINDOW_LABEL

/**
 * 이 창이 그려야 할 메뉴 id. 뷰 창이 아니면 null.
 * Rust 가 `index.html?view=<메뉴 id>` 로 창을 만들지만, 쿼리가 없으면 창 라벨에서 되돌린다.
 */
export function viewWindowMenuId(): string | null {
  if (!isViewWindow) return null
  const fromQuery = new URLSearchParams(location.search).get("view")
  return fromQuery || WINDOW_LABEL.slice(VIEW_WINDOW_PREFIX.length)
}

/**
 * 네이티브 자식 웹뷰(임베드 브라우저) 라벨 — 창마다 달라야 한다.
 *
 * 웹뷰 라벨은 앱 전체에서 유일하고, 웹뷰는 만들어진 창에 붙는다. 같은 화면을 메인 창과
 * 새 창에서 동시에 열면 라벨이 겹쳐 한쪽이 상대의 웹뷰를 자기 좌표로 끌어가 버리므로,
 * 메인 창이 아니면 창 라벨을 끼워 넣는다. lib.rs 의 BROWSER_PREFIX 로 시작해야
 * 페이지 내부 링크가 외부 브라우저로 가로채이지 않는다.
 */
export function browserLabel(suffix: string): string {
  return isMainWindow
    ? `browser-tab-${suffix}`
    : `browser-tab-${WINDOW_LABEL}-${suffix}`
}
