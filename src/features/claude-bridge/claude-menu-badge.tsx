import { useHerdr } from "./use-herdr"

/**
 * 사이드바 "세션 목록" 메뉴에 붙는 작업 개수 배지.
 * 진행 중(working)과 완료(done) 워크스페이스 수를 각각 나눠 보여 주고,
 * 둘 다 0건이면 표시하지 않는다.
 */
export function ClaudeMenuBadge() {
  const { workspaces } = useHerdr()
  const running = workspaces.filter((w) => w.agent_status === "working").length
  const done = workspaces.filter((w) => w.agent_status === "done").length
  if (running === 0 && done === 0) return null

  const fmt = (n: number) => (n > 99 ? "99+" : n)

  // 진행 중(초록 알약 + 깜빡이는 점) / 완료(파란 알약) — 카드 상태칩과 같은 색.
  return (
    <span className="ml-auto inline-flex shrink-0 items-center gap-1">
      {running > 0 && (
        <span className="inline-flex items-center gap-1 rounded-full bg-ui-success px-1.5 text-[11px] leading-5 font-bold text-white tabular-nums">
          <span className="inline-block size-1.5 animate-pulse rounded-full bg-current" />
          {fmt(running)}
        </span>
      )}
      {done > 0 && (
        <span className="inline-flex items-center rounded-full bg-ui-info px-1.5 text-[11px] leading-5 font-bold text-white tabular-nums">
          {fmt(done)}
        </span>
      )}
    </span>
  )
}
