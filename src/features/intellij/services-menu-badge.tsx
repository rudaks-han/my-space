import { useRunningCount } from "./use-running-count"
import type { ServicesBackend } from "./use-services"

/**
 * 사이드바 "IntelliJ 서비스" · "Cowork 서비스" 메뉴에 붙는 실행 중 서비스 개수 배지.
 * 0건이면 표시하지 않는다(멈춰 있는 게 정상 상태라 0 을 띄우면 그냥 잡음이다).
 */
export function ServicesMenuBadge({ backend }: { backend: ServicesBackend }) {
  const count = useRunningCount(backend)
  if (count === 0) return null

  // 서비스 카드의 "실행 중" 칩과 같은 언어 — 초록 + 깜빡이는 점.
  return (
    <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-ui-success px-1.5 text-[11px] leading-5 font-bold text-white tabular-nums">
      <span className="inline-block size-1.5 animate-pulse rounded-full bg-current" />
      {count > 99 ? "99+" : count}
    </span>
  )
}
