/**
 * 서비스 로그를 그리는 부분 — 콘솔 화면 두 개가 이것만 공유한다.
 *
 * IntelliJ 서비스 · Cowork 서비스의 오른쪽 콘솔과 IntelliJ Cowork 화면 아래 독은 툴바도
 * 상태 표시도 다르지만, **로그 본문은 같아야 한다** — 같은 프로세스의 같은 출력을
 * 두 곳에서 다른 색·다른 스크롤 규칙으로 그리면 어느 쪽이 맞는지 알 수 없다. 그래서
 * 툴바는 각자 두고 스크롤 영역과 줄 렌더링만 여기로 뺐다. 독처럼 좁은 자리는
 * `className` 으로 여백과 글자 크기만 조인다(`p-2 text-[12px]`).
 */

import { memo, useCallback, useEffect, useRef, useState } from "react"
import type { UIEvent } from "react"
import { ArrowDownToLineIcon, Trash2Icon } from "lucide-react"

import {
  FloatingMenu,
  FloatingMenuItem,
} from "@/components/shell/floating-menu"
import { cn } from "@/lib/utils"
import { highlightLogLine } from "./console-highlight"

/** 바닥에서 이 안쪽이면 "따라가는 중" 으로 본다(px). */
const STICK_SLACK = 40

/**
 * 콘솔의 스크롤 — 따라가기 · **얼리기** · 맨 아래로.
 *
 * 새 줄이 오면 바닥에 붙어 따라가되, 사용자가 위로 올려 과거 로그를 보고 있으면
 * 그 화면을 **통째로 얼린다**. 자동 스크롤만 끄는 것으로는 부족하다: 로그는
 * `MAX_LOG_LINES`(2000줄)를 넘으면 **앞에서 잘려 나가므로**, `scrollTop` 을 그대로 둬도
 * 읽던 줄이 위로 밀려 올라간다(Spring Boot 부팅 로그는 그 상한을 금방 넘는다). 게다가
 * 줄이 잘리면 드래그해 둔 선택 영역까지 끊긴다 — 로그를 복사하려던 사람에게는 그게 더
 * 큰 문제다. 그래서 위로 올린 동안에는 그릴 배열 자체를 붙잡아 DOM 을 건드리지 않는다.
 *
 * 밀린 줄은 버리지 않는다. 부모가 주는 `lines` 는 계속 자라고 있고, 바닥으로 돌아가면
 * 그때 최신 배열로 한 번에 갈아 끼운다.
 *
 * 따라가는지 여부를 **ref 와 state 로 둘 다** 들고 있다. 붙어 있는지는 새 줄이 올 때마다
 * 동기적으로 읽어야 하므로(effect 안에서 최신값이어야 한다) ref 가 필요하고, 알약은
 * 그 값이 바뀔 때 다시 그려져야 하므로 state 도 필요하다 — 세션 목록의 로그 창
 * (`claude-bridge-view`)이 쓰는 것과 같은 짝이다.
 *
 * **`target` 이 바뀌면 이 상태를 전부 버린다.** 얼린 화면은 `lines` 가 아니라 스냅샷을
 * 그리므로, 그대로 두면 다른 서비스를 골라도 **이전 서비스의 로그가 계속 보인다** —
 * 일괄 실행은 단계마다 선택을 자동으로 옮기므로(`services-dock.tsx`) 로그를 한 번
 * 올려 본 것만으로 선택과 화면이 영영 어긋난다. 스크롤 위치도 함께 버리는 것이 맞다:
 * 다른 프로세스의 출력이라 "몇 픽셀에서 읽고 있었는지" 는 이어질 수 없다.
 */
function useConsoleScroll(lines: string[], target: string | undefined) {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [following, setFollowing] = useState(true)
  /** 얼려 둔 화면. `null` 이면 최신 `lines` 를 그대로 그린다. */
  const [frozen, setFrozen] = useState<string[] | null>(null)

  /*
   * 스크롤 판정은 JSX 핸들러로 붙인다(`addEventListener` 가 아니라). 얼릴 때 **그 순간의
   * `lines`** 를 스냅샷으로 떠야 하는데, effect 안에서 한 번 등록한 리스너는 첫 렌더의
   * `lines` 를 계속 붙들고 있어 빈 화면을 얼려 버린다.
   */
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLACK
    pinned.current = atBottom
    // 매 스크롤 프레임마다 렌더하지 않도록 값이 바뀔 때만 알린다.
    setFollowing((prev) => (prev === atBottom ? prev : atBottom))
    // 이미 얼려 둔 화면은 그대로 둔다 — 위에서 더 위로 올릴 때마다 스냅샷을 새로 뜨면
    // 그 사이 밀려 있던 줄이 한꺼번에 들어와, 가만히 있어야 할 화면이 그때 튄다.
    setFrozen((prev) => (atBottom ? null : (prev ?? lines)))
  }

  /*
   * 대상이 바뀌면 얼린 화면을 푼다. 렌더 중에 되돌리는 이유는 이 한 프레임이 곧
   * 문제이기 때문이다 — effect 로 미루면 새 서비스를 고른 직후 한 번은 옛 서비스의
   * 로그가 그려진다. state 만 여기서 손대고 `pinned`(ref)는 아래 effect 가 맡는다.
   */
  const [prevTarget, setPrevTarget] = useState(target)
  if (target !== prevTarget) {
    setPrevTarget(target)
    setFrozen(null)
    setFollowing(true)
  }

  /** 화면에 실제로 그릴 줄. */
  const shown = frozen ?? lines
  /** 얼린 뒤 새 줄이 도착했는지 — 알약이 "왜 안 늘어나는지" 를 말해 준다. */
  const stale = frozen != null && frozen !== lines

  // 얼려 있는 동안 `shown` 은 같은 배열이라 이 effect 가 아예 돌지 않는다.
  useEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [shown])

  /*
   * 대상이 바뀌었을 때의 스크롤. 위 effect 뒤에 선언해야 한다 — 실행 순서가 선언
   * 순서라, 먼저 두면 `pinned` 가 아직 false 인 위 effect 가 나중에 돌면서 방금 내린
   * 화면을 그 자리에 둔다. 로그는 `loadLogs` 로 조금 늦게 채워지므로 그때의 마지막
   * 한 칸은 위 effect 가 맡는다(이제 `pinned` 가 true 다).
   */
  useEffect(() => {
    pinned.current = true
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [target])

  /**
   * IntelliJ 콘솔의 Scroll to End — 얼린 화면을 풀고 맨 아래로 내린다.
   *
   * `pinned` 를 여기서 직접 올리는 이유: `scrollTop` 대입이 만드는 scroll 이벤트는
   * 다음 프레임에 오는데, 그 사이에 새 줄이 도착하면 위 effect 가 아직 `false` 인
   * `pinned` 를 보고 따라가지 않는다 — 버튼을 눌렀는데 한 박자 뒤 다시 멈춘 것처럼 보인다.
   * 밀려 있던 줄까지 붙는 마지막 한 칸은 위 effect 가 맡는다(지금은 아직 DOM 에 없다).
   */
  const scrollToEnd = useCallback(() => {
    pinned.current = true
    setFollowing(true)
    setFrozen(null)
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  return { ref, onScroll, following, stale, shown, scrollToEnd }
}

/**
 * 로그 한 줄 — IntelliJ 콘솔과 같은 구문 강조.
 *
 * 무엇을 무슨 색으로 칠할지는 `console-highlight.ts` 가 정한다(로그가 찍은 ANSI 를
 * 우선 쓰고, 없으면 로그 패턴을 뜯는다). 여기서는 그 조각을 그리는 일과, 로그 줄이
 * 아닌 두 가지만 따로 본다 — 이 앱이 끼워 넣은 안내(`[my-space]`)와 스택트레이스.
 *
 * `memo` 인 이유: 콘솔은 수천 줄을 한 배열로 그리는데 줄이 하나 붙을 때마다 그 배열이
 * 새로 만들어진다. 줄 문자열 자체는 그대로이므로 memo 가 나머지 줄의 재파싱을 전부 막는다.
 */
export const LogLine = memo(function LogLine({ line }: { line: string }) {
  // 이 앱이 직접 끼워 넣은 안내 줄은 구분해서 보여준다.
  if (line.startsWith("[my-space]")) {
    return (
      <div className="whitespace-pre text-muted-foreground italic">{line}</div>
    )
  }
  // 스택트레이스는 예외 하나에 수십 줄이 딸려 온다 — 통째로 눌러 본문을 가리지 않게.
  const trace = line.startsWith("\tat ") || line.startsWith("  at ")
  return (
    // IntelliJ 콘솔처럼 줄바꿈하지 않고 가로로 스크롤한다.
    <div className={cn("whitespace-pre", trace && "text-muted-foreground")}>
      {highlightLogLine(line).map((seg, i) => (
        <span key={i} className={seg.className}>
          {seg.text}
        </span>
      ))}
    </div>
  )
})

/**
 * 스크롤되는 로그 본문.
 *
 * 새 줄이 오면 바닥에 붙어 따라가되, 사용자가 위로 올려 과거 로그를 보고 있으면 화면을
 * 통째로 얼린다(`useConsoleScroll`). `key={i}` 인 것은 배열이 뒤로만 자라기 때문이고,
 * 줄 문자열이 그대로면 `LogLine` 의 memo 가 재파싱을 막는다.
 *
 * **지우기와 맨 아래로는 본문 우클릭에도 둔다** — IntelliJ 콘솔의 Clear All ·
 * Scroll to End 가 있는 자리다. 툴바의 휴지통 버튼은 화면마다 다른 자리에 있고(독은
 * 탭 줄 오른쪽 끝의 12px 아이콘, 큰 화면은 ⌘ 다중 선택 중이면 일괄 툴바로 바뀌어 아예
 * 사라진다), 그래서 콘솔을 보다가 지우려는 사람이 찾지 못한다. 메뉴를 본문에 두면 세
 * 화면이 같은 자리를 갖는다.
 */
export function ConsoleLog({
  lines,
  className,
  onClear,
  title,
}: {
  lines: string[]
  className?: string
  /** 우클릭 → 모두 지우기. 넘기지 않으면 지우기 항목이 빠진다(맨 아래로는 남는다). */
  onClear?: () => void
  /**
   * 지금 보고 있는 콘솔의 **대상**(서비스 이름) — 우클릭 메뉴 머리에 붙어 어느 서비스의
   * 콘솔을 지우는지 확인시켜 주고, **이 값이 바뀌면 화면 상태를 리셋한다**
   * (`useConsoleScroll` 참고 — 얼린 화면이 남으면 선택과 로그가 어긋난다).
   *
   * 고른 서비스가 없을 수 있어 `undefined` 를 받지만 **옵셔널이 아니다**: 대상을 넘기지
   * 않은 새 호출처는 그 리셋을 조용히 잃게 되므로, 빈 값이라도 명시하게 한다.
   */
  title: string | undefined
}) {
  const { ref, onScroll, following, stale, shown, scrollToEnd } =
    useConsoleScroll(lines, title)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  return (
    <>
      {/* 알약을 콘솔 안에 절대 배치하려면 기준이 필요하다. 이 겹이 대신 `flex-1` 을 받고
          스크롤은 안쪽이 그대로 맡으므로, 부모가 보는 계약(늘어나는 flex 자식 하나)은 같다. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* ui-selectable: body 에 select-none 이 걸려 있어서 콘솔은 명시적으로 되돌린다
            (로그를 드래그해 복사할 수 있어야 한다). */}
        <div
          ref={ref}
          onScroll={onScroll}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY })
          }}
          className={cn(
            "ui-selectable min-h-0 flex-1 cursor-text overflow-auto bg-muted/30 p-4 font-mono text-[13px] leading-relaxed",
            className
          )}
        >
          {shown.length === 0 ? (
            <div className="text-muted-foreground">
              아직 출력이 없습니다. ▶ 를 눌러 실행하세요.
            </div>
          ) : (
            // min-w-max: 가장 긴 줄만큼 넓어져 가로 스크롤이 생긴다.
            <div className="min-w-max">
              {shown.map((l, i) => (
                <LogLine key={i} line={l} />
              ))}
            </div>
          )}
        </div>

        {/*
         * Scroll to End — 위로 올려 과거 로그를 보는 동안에만 뜬다.
         *
         * IntelliJ 는 콘솔 옆 세로 툴바에 이 버튼을 상시 두고 바닥에서는 비활성으로 두지만,
         * 여기 콘솔은 툴바가 화면마다 다르고(독은 헤더가 32px 한 줄뿐이다) 본문 위에 상시
         * 떠 있는 알약은 로그 한 줄을 가린다. 바닥에 붙어 있을 때는 누를 이유도 없으므로
         * 필요한 순간에만 띄운다 — 세션 목록의 로그 창이 쓰는 것과 같은 알약이다.
         */}
        {!following && shown.length > 0 && (
          <button
            type="button"
            onClick={scrollToEnd}
            title={
              stale
                ? "화면을 멈춰 두어 새 줄이 아직 붙지 않았습니다. 누르면 맨 아래로 내리며 다시 따라갑니다(IntelliJ 의 Scroll to End)."
                : "맨 아래로 — 다시 새 줄을 따라갑니다(IntelliJ 의 Scroll to End)"
            }
            className="absolute right-3 bottom-3 inline-flex cursor-pointer items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-bold shadow-[0_4px_16px_rgba(0,0,0,0.16)] transition-colors hover:bg-ui-list-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid"
          >
            {/* 얼려 둔 사실을 말해 주지 않으면 "로그가 멈췄다" 로 읽힌다 — 이 알약이
                그 상태의 유일한 표시이자 되돌아가는 길이다. */}
            {stale && (
              <span className="mr-0.5 size-1.5 rounded-full bg-ui-success" />
            )}
            {stale ? "새 줄 있음 · 맨 아래로" : "맨 아래로"}
            <ArrowDownToLineIcon className="size-3" />
          </button>
        )}
      </div>

      {/* `fixed` 라 흐름 밖에 있다 — 콘솔이 flex 자식으로 늘어나는 계약은 그대로다. */}
      {menu && (
        <FloatingMenu
          x={menu.x}
          y={menu.y}
          title={title ?? "콘솔"}
          onClose={() => setMenu(null)}
        >
          {onClear && (
            <FloatingMenuItem
              icon={Trash2Icon}
              label="모두 지우기"
              onClick={() => {
                onClear()
                setMenu(null)
              }}
            />
          )}
          {/* 알약과 같은 동작이지만 알약은 위로 올렸을 때만 뜬다 — 메뉴에는 늘 둔다.
              이미 바닥이면 눌러도 제자리이므로 감출 이유가 없다. */}
          <FloatingMenuItem
            icon={ArrowDownToLineIcon}
            label="맨 아래로"
            onClick={() => {
              scrollToEnd()
              setMenu(null)
            }}
          />
        </FloatingMenu>
      )}
    </>
  )
}
