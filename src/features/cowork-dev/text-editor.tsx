import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { LockIcon } from "lucide-react"

import { highlightCode, modeForPath } from "@/lib/code-highlight"
import { useUndoHistory } from "@/lib/use-undo-history"
import { cn } from "@/lib/utils"

/**
 * IntelliJ Cowork 화면의 **일반 텍스트 편집기** — `.http` 가 아닌 모든 파일이 여기로 열린다.
 *
 * CodeMirror 를 **편집기로** 올리지는 않았다. 이 저장소는 CodeMirror 5 를 runMode(정적
 * 토큰화)로만 쓰고 있고, 편집기 인스턴스를 붙이는 순간 테마·키맵·React 동기화가 딸려 온다.
 * 그래서 `.http` 편집기(`intellij-http/http-editor.tsx`)와 **완전히 같은 배치**를 쓴다:
 * 구문 강조된 `<pre>` 가 글자를 그리고, 그 위에 글자가 투명한 `<textarea>` 를 겹쳐 입력만
 * 받는다. 색은 `@/lib/code-highlight` 가 확장자로 모드를 골라 `.cm-*` span 을 만들고
 * `index.css` 의 `.dev-code` 규칙이 입힌다.
 *
 * 정렬의 규칙 세 가지 — 어긴 순간 거터·강조와 글자가 어긋난다:
 *  1. 두 층의 폰트·크기·줄높이·패딩이 **완전히 같은 값**이어야 한다(`FONT` + 같은
 *     `text-[13px] leading-[20px]` 클래스). 강조가 굵기를 바꾸지 않는 이유도 이것이다.
 *  2. 줄바꿈을 하지 않는다(`wrap="off"` + `white-space: pre`). 소프트랩을 켜면 줄 번호가
 *     논리 줄과 어긋나고, 맞추려면 줄마다 높이를 재야 한다.
 *  3. 스크롤은 **바깥 컨테이너**가 한다(textarea 높이 = 내용 높이). 그래야 거터를
 *     `sticky left-0` 로 붙여 둘 수 있고 세로 스크롤이 번호·강조와 함께 움직인다.
 *
 * 가로 폭도 `<pre>` 가 정한다 — textarea 는 내용 폭을 알려 주지 않으므로, 같은 글자를
 * 그리는 `<pre>` 의 `max-content` 폭 위에 textarea 를 겹쳐 늘린다.
 */

const LINE_H = 20
const PAD_Y = 8

/**
 * 이 크기를 넘으면 **타이핑 중에는** 강조를 미룬다(`code-highlight.ts` 의
 * `MAX_HIGHLIGHT_BYTES` 는 파일을 여는 비용의 상한이라 역할이 다르다). 64KB 는 이
 * 저장소의 큰 소스 파일 대부분이 안에 드는 값이라, 평소에는 미루는 경로가 아예 돌지 않는다.
 */
const LIVE_HIGHLIGHT_BYTES = 64 * 1024
/** 손을 멈춘 것으로 볼 시간. 이보다 짧으면 연타 도중에도 강조 계산이 끼어든다. */
const SETTLE_MS = 180

/** 두 층(`<pre>` · `<textarea>`)이 **완전히 같은 값**을 써야 한다. 크기는 배율을 타야
 *  하므로 `text-[13px] leading-[20px]` 클래스로 주고, 여기에는 나머지만 둔다. */
const FONT: React.CSSProperties = {
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  padding: `${PAD_Y}px 12px`,
  tabSize: 2,
}

export function TextEditor({
  path,
  text,
  onChange,
  onSave,
  readOnly = false,
  readOnlyReason,
  active = true,
}: {
  /** 절대 경로 — 표시용이자 "다른 파일로 갈아끼워졌다"는 신호다. */
  path: string
  text: string
  onChange: (v: string) => void
  onSave: () => void
  /** 바이너리·2MB 초과처럼 되쓰면 안 되는 파일. 편집을 막고 띠를 띄운다. */
  readOnly?: boolean
  /** 띠에 적을 사유(버퍼의 `error`). 없으면 일반 문구. */
  readOnlyReason?: string | null
  /** 이 탭이 지금 보이는가 — 탭이 켜질 때 편집기로 포커스를 옮기는 데만 쓴다. */
  active?: boolean
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  /** 프로그램적으로 값을 바꾼 뒤 되돌릴 커서 위치(탭 삽입·자동 들여쓰기). */
  const caretRef = useRef<number | null>(null)

  const lineCount = useMemo(() => {
    let n = 1
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
    return n
  }, [text])

  /*
   * 구문 강조. 두 단계로 나눠 memo 하는 이유가 각각 있다:
   *  - `mode` 는 **경로**만 보므로 파일이 바뀔 때만 다시 고른다(글자를 칠 때마다 확장자를
   *    다시 자를 이유가 없다).
   *  - `html` 은 글자가 바뀔 때마다 다시 만들어야 하지만, 부모가 리렌더될 때마다(예: 옆
   *    패널의 폭 조절) 수천 줄을 다시 토큰화하면 드래그가 끊긴다.
   * 모르는 확장자·상한 초과는 `highlightCode` 안에서 이스케이프한 원문으로 처리되므로
   * 여기에 분기가 없다 — 화면을 그리는 경로는 언제나 하나다.
   */
  const mode = useMemo(() => modeForPath(path), [path])

  /*
   * `MAX_HIGHLIGHT_BYTES`(512KB)는 **파일을 여는** 비용의 상한이고, **글자를 치는** 비용은
   * 따로 막아야 한다. 300KB 짜리 `.java` 는 상한 안이라 강조되는데, 한 글자를 칠 때마다
   * 전체를 다시 토큰화하고 수만 개의 `<span>` 을 새로 파싱하게 되어 편집이 불가능해졌다.
   *
   * 그래서 이 크기 위에서는 타이핑 중에는 **이스케이프한 원문만** 그린다(`mode: null` 이
   * 곧 그 경로다 — 분기를 하나만 유지한다). 손을 멈추면 그때 강조가 얹힌다.
   *
   * 미룬 본문을 그리지 않고 **항상 현재 본문**을 그리는 것이 핵심이다: `<pre>` 와
   * `<textarea>` 는 글자 폭이 완전히 같아야 겹쳐 놓을 수 있고, 줄 수도 거터·높이 계산과
   * 맞아야 한다. `useDeferredValue` 로 옛 본문을 칠하면 그 두 계약이 동시에 깨진다.
   */
  const heavy = text.length > LIVE_HIGHLIGHT_BYTES
  const [settled, setSettled] = useState(text)
  useEffect(() => {
    if (!heavy || settled === text) return
    const t = setTimeout(() => setSettled(text), SETTLE_MS)
    return () => clearTimeout(t)
    // 상태를 바꾸는 것이 effect 본문이 아니라 **타이머**라서 `set-state-in-effect` 가
    // 걸리지 않는다(입력이라는 외부 사건에 뒤늦게 반응하는 자리라 effect 가 맞다).
  }, [text, heavy, settled])

  const live = !heavy || settled === text
  const html = useMemo(
    () => highlightCode(text, live ? mode : null),
    [text, mode, live]
  )

  /*
   * 줄 번호는 `<div>` 를 줄 수만큼 만들지 않고 **문자열 하나**로 그린다. 여기 열리는
   * 파일은 2MB 까지라 수만 줄이 예사인데, 그만큼의 DOM 노드는 탭을 전환할 때마다
   * 렌더가 눈에 띄게 멈춘다. 줄높이가 고정(20px)이라 한 덩어리로도 정확히 맞는다.
   */
  const numbers = useMemo(() => {
    const out: string[] = new Array(lineCount)
    for (let i = 0; i < lineCount; i++) out[i] = String(i + 1)
    return out.join("\n")
  }, [lineCount])

  const gutterW = Math.max(46, String(lineCount).length * 9 + 22)
  const height = lineCount * LINE_H + PAD_Y * 2

  // 바꾼 값이 반영된 뒤 커서를 되돌린다(그러지 않으면 탭을 넣을 때마다 맨 뒤로 튄다).
  useLayoutEffect(() => {
    if (caretRef.current != null && taRef.current) {
      taRef.current.setSelectionRange(caretRef.current, caretRef.current)
      caretRef.current = null
    }
  }, [text])

  /*
   * 탭이 켜지면 편집기가 포커스를 가져간다 — 안 그러면 파일을 열자마자 친 ⌘S 나
   * 글자가 아무 데도 가지 않는다. 탭은 keep-alive 라 언마운트되지 않으므로
   * "false → true 로 바뀐 순간"에만 부른다(매 렌더 포커스를 뺏으면 안 된다).
   */
  const wasActive = useRef(false)
  useEffect(() => {
    if (active && !wasActive.current) taRef.current?.focus()
    wasActive.current = active
  }, [active])

  /**
   * 커서가 화면 밖으로 나갔을 때만 최소한으로 굴린다. 스크롤을 바깥 컨테이너가
   * 하므로(위 주석 2번) 브라우저가 커서를 따라 굴려 주지 않는다. "나갔을 때만"인
   * 이유는 사용자가 직접 굴려 둔 위치를 되돌리지 않기 위해서다.
   */
  const scrollCaretIntoView = () => {
    const ta = taRef.current
    if (!ta) return
    const box = ta.closest("[data-dev-scroll]")
    if (!(box instanceof HTMLElement)) return
    let line = 0
    const upto = ta.value.slice(0, ta.selectionStart)
    for (let i = 0; i < upto.length; i++) if (upto.charCodeAt(i) === 10) line++
    // 위쪽 패딩(`PAD_Y`)만큼 내려와 있으므로 그것을 더해야 실제 줄 위치가 된다.
    const top = PAD_Y + line * LINE_H
    const bottom = top + LINE_H
    if (top < box.scrollTop) box.scrollTop = Math.max(0, top - PAD_Y)
    else if (bottom > box.scrollTop + box.clientHeight)
      box.scrollTop = bottom - box.clientHeight
  }

  /*
   * 되돌리기 이력. 웹뷰 기본 ⌘Z 를 쓸 수 없는 이유는 `use-undo-history.ts` 머리말에 있다.
   * 이력은 이 컴포넌트에 붙어 있고 탭은 전부 마운트된 채 겹쳐 두므로(뷰의 탭 본문 주석
   * 참고), 다른 탭에 갔다 돌아와도 이력이 그대로 남는다.
   */
  const history = useUndoHistory({
    taRef,
    text,
    onChange,
    setCaret: (n) => {
      caretRef.current = n
    },
    readOnly,
  })

  const setValueCaret = (v: string, caret: number) => {
    // 코드가 값을 갈아끼우기 직전 — 이 한 번이 되돌리기 한 단계가 된다. 커서는 아직
    // 옮겨지지 않았으므로(호출부가 기본 동작을 막았다) 지금 값이 곧 "직전 위치"다.
    history.capture(taRef.current?.selectionStart ?? caret)
    caretRef.current = caret
    onChange(v)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = taRef.current
    if (!ta) return
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      // 브라우저(웹뷰)의 "페이지 저장"을 막고 우리 저장을 부른다. 읽기 전용일 때도
      // 그대로 부른다 — 버퍼가 거절 사유를 error 로 돌려주므로 띠에 이유가 뜬다.
      e.preventDefault()
      onSave()
      return
    }
    // ⌘Z / ⌘⇧Z. ⌘S 다음에 두는 이유는 저장이 읽기 전용에서도 사유를 띄워야 하기
    // 때문이고, 되돌리기는 스스로 읽기 전용을 판단하므로 그 아래 `return` 보다 위다.
    if (history.handleKey(e)) return
    if (readOnly) return
    if (e.key === "Tab") {
      // 포커스를 다음 요소로 넘기지 않고 두 칸을 넣는다(편집기 안에서는 들여쓰기다).
      e.preventDefault()
      const s = ta.selectionStart
      const end = ta.selectionEnd
      setValueCaret(ta.value.slice(0, s) + "  " + ta.value.slice(end), s + 2)
      return
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      // 앞 줄의 들여쓰기를 이어 준다 — 코드 편집에서는 이게 없으면 매 줄 손으로 맞춰야 한다.
      const s = ta.selectionStart
      if (s !== ta.selectionEnd) return
      const lineStart = ta.value.lastIndexOf("\n", s - 1) + 1
      const indent = (ta.value.slice(lineStart, s).match(/^[ \t]*/) || [""])[0]
      if (!indent) return
      e.preventDefault()
      const ins = "\n" + indent
      setValueCaret(
        ta.value.slice(0, s) + ins + ta.value.slice(s),
        s + ins.length
      )
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {readOnly && (
        <div className="flex items-start gap-2 rounded-[10px] border border-border bg-ui-warning/10 px-3 py-2 text-[13px] text-ui-warning">
          <LockIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {readOnlyReason ?? "읽기 전용 파일입니다 — 저장할 수 없습니다."}
          </span>
        </div>
      )}

      {readOnly && text.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center rounded-[10px] border border-border bg-background text-[13px] text-muted-foreground shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          미리 볼 수 있는 텍스트가 없습니다.
        </div>
      ) : (
        <div
          data-dev-scroll
          className="relative min-h-0 flex-1 overflow-auto rounded-[10px] border border-border bg-background shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
        >
          <div className="flex" style={{ minWidth: "100%", height }}>
            {/* 거터 — 줄 번호. 가로로 굴려도 제자리에 남는다. */}
            <pre
              aria-hidden
              className="sticky left-0 z-10 m-0 shrink-0 border-r border-border bg-muted/40 text-right text-[11px] leading-[20px] text-muted-foreground/60 tabular-nums select-none"
              style={{
                ...FONT,
                width: gutterW,
                padding: `${PAD_Y}px 8px ${PAD_Y}px 0`,
              }}
            >
              {numbers}
            </pre>

            <div
              className="relative"
              style={{ minWidth: "max-content", flex: 1 }}
            >
              {/*
                눈에 보이는 글자를 그리는 층이자 폭 자. 두 가지가 계약이다:

                - `select-none`. 텍스트를 **고르는** 층은 위에 겹친 textarea 다. 여기가
                  선택 가능하면 거터에서 시작한 드래그나 편집기 밖에서 누른 ⌘A 가 이
                  `<pre>` 를 잡아, 아무것도 고르지 않았는데 파란 띠가 깔린 채 남는다.
                - 끝의 `"\n"`. 이 한 글자가 `<pre>` 를 한 줄 더 높게 만들어 마지막 줄까지
                  textarea 밑에 자리를 남긴다 — 빼면 맨 끝 줄을 클릭할 수 없다.
              */}
              <pre
                aria-hidden
                className="dev-code pointer-events-none m-0 overflow-hidden text-[13px] leading-[20px] break-normal whitespace-pre text-foreground select-none"
                style={FONT}
                dangerouslySetInnerHTML={{ __html: html + "\n" }}
              />
              <textarea
                ref={taRef}
                value={text}
                aria-label={path}
                readOnly={readOnly}
                wrap="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => {
                  onChange(e.target.value)
                  requestAnimationFrame(scrollCaretIntoView)
                }}
                onKeyDown={onKeyDown}
                onKeyUp={scrollCaretIntoView}
                /*
                  글자는 투명하다(아래 `<pre>` 가 그린다) — 그래서 선택 배경도 **반투명**
                  이어야 한다. 불투명한 기본 선택색을 쓰면 드래그한 범위의 글자가 파란
                  덩어리에 가려 사라진다. `selection:text-transparent` 도 필요하다:
                  웹뷰가 선택 영역의 글자색을 자기 기본값으로 되돌려 버리면, 투명해야 할
                  이 층의 글자가 아래 강조된 글자 위에 겹쳐 두 겹으로 보인다.
                */
                className={cn(
                  "absolute inset-0 size-full resize-none overflow-hidden border-0 bg-transparent text-[13px] leading-[20px] whitespace-pre text-transparent caret-foreground outline-none selection:bg-ui-selection/30 selection:text-transparent",
                  readOnly && "cursor-default"
                )}
                style={FONT}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
