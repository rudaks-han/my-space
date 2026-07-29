import type { ReactNode } from "react"

import { MENUS } from "@/menus"

/*
 * 빠른 이동 다이얼의 데이터. 그림(버튼)은 `pet-dial.tsx` 에 있다 —
 * 컴포넌트 파일이 컴포넌트 외의 값을 export 하면 fast refresh 가 깨지므로 나눴다
 * (pet-species.ts / pet-species-art.tsx 와 같은 이유).
 */

/** 다이얼 버튼 한 칸. */
export interface PetDialItem {
  menuId: string
  title: string
  /** 메뉴 아이콘(lucide 또는 브랜드 로고) — `menus.tsx` 의 것을 그대로 쓴다. */
  Icon: (props: { className?: string }) => ReactNode
  /** 뱃지에 보일 건수. 0 이면 뱃지를 그리지 않는다. */
  count: number
}

/**
 * 설정에서 고른 메뉴 id 들을 다이얼 항목으로 바꾼다.
 *
 * 아이콘·이름을 여기서 다시 정의하지 않고 `MENUS` 를 읽는 이유: 메뉴 이름이나 아이콘을
 * 바꿀 때 두 곳이 갈라지지 않게 하려고. 순서도 `MENUS`(사이드바) 순서를 따른다 —
 * 고른 순서대로 두면 설정을 만질 때마다 아이콘 자리가 바뀌어 손이 기억한 위치가 깨진다.
 */
export function toDialItems(
  menuIds: string[],
  counts: Record<string, number>
): PetDialItem[] {
  const picked = new Set(menuIds)
  return MENUS.filter((m) => picked.has(m.id)).map((m) => ({
    menuId: m.id,
    title: m.title,
    Icon: m.icon as PetDialItem["Icon"],
    count: counts[m.id] ?? 0,
  }))
}
