import type { ReactNode } from "react"

import { NavigationContext } from "./use-navigation"

/** 메뉴 전환 함수를 하위 트리에 공급한다(App 이 활성 메뉴 상태를 들고 있다). */
export function NavigationProvider({
  onNavigate,
  children,
}: {
  onNavigate: (menuId: string) => void
  children: ReactNode
}) {
  return (
    <NavigationContext.Provider value={onNavigate}>
      {children}
    </NavigationContext.Provider>
  )
}
