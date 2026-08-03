import { useLayoutEffect, useMemo, useRef } from "react"
import { Loader2Icon, PlayIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { highlightHttp } from "./http-highlight"
import { requestLabel, type HttpRequest } from "./http-parse"

/**
 * `.http` 편집기 — 구문 강조된 `<pre>` 위에 투명한 `<textarea>` 를 겹친 것.
 *
 * CodeMirror 를 편집기로 올리지 않은 이유: 이 저장소는 CodeMirror 5 를 **runMode(정적
 * 토큰화)로만** 쓰고 있고(`cowork-spec/highlight.ts`), 편집기 인스턴스를 붙이면 테마·키맵·
 * React 동기화가 따라온다. 여기서 필요한 것은 강조와 거터의 ▶ 뿐이라 그 값이 안 맞는다.
 *
 * 정렬의 규칙 세 가지 — 어긴 순간 글자와 강조가 어긋난다:
 *  1. `<pre>` 와 `<textarea>` 는 폰트·줄높이·패딩이 **완전히 같은 값**이어야 한다(`FONT`).
 *  2. 줄바꿈을 하지 않는다(`wrap="off"` + `white-space: pre`). 소프트랩을 켜면 거터의
 *     줄 번호가 논리 줄과 어긋나고, 그걸 맞추려면 줄별 높이를 재는 코드가 필요해진다.
 *  3. 스크롤은 **바깥 컨테이너**가 한다(textarea 높이 = 내용 높이). 그래서 거터를
 *     `sticky left-0` 로 붙여 둘 수 있고, 세로 스크롤이 강조와 자동으로 같이 움직인다.
 */

const LINE_H = 20
const PAD_Y = 8
const GUTTER = 46

const FONT: React.CSSProperties = {
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  fontSize: 13,
  lineHeight: `${LINE_H}px`,
  padding: `${PAD_Y}px 12px`,
  tabSize: 2,
}

export function HttpEditor({
  text,
  onChange,
  requests,
  resolveVar,
  runningIndexes,
  activeIndex,
  onRun,
  onSave,
  caretLine,
  onCaretLine,
  scrollToLine,
}: {
  text: string
  onChange: (v: string) => void
  requests: HttpRequest[]
  resolveVar: (name: string) => boolean
  /** 지금 실행 중인 요청 순번들. */
  runningIndexes: Set<number>
  /** 커서가 놓인 요청 순번(거터 ▶ 강조). */
  activeIndex: number | null
  onRun: (req: HttpRequest) => void
  onSave: () => void
  caretLine: number
  onCaretLine: (line: number) => void
  /**
   * 이 줄로 스크롤하고 커서를 놓아 달라는 요청. 값이 바뀔 때만 동작하도록
   * `{ line, seq }` 로 받는다 — 같은 요청을 두 번 눌렀을 때도 반응해야 한다.
   */
  scrollToLine: { line: number; seq: number } | null
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const caretRef = useRef<number | null>(null)

  const lines = useMemo(() => text.split("\n"), [text])
  const html = useMemo(
    () => highlightHttp(text, resolveVar),
    [text, resolveVar]
  )
  /** 줄 번호 → 그 줄에서 시작하는 요청. 거터의 ▶ 자리. */
  const runnable = useMemo(() => {
    const m = new Map<number, HttpRequest>()
    requests.forEach((r) => m.set(r.requestLine, r))
    return m
  }, [requests])

  const height = lines.length * LINE_H + PAD_Y * 2

  // 프로그램적으로 바꾼 값이 반영된 뒤 caret 복원(들여쓰기·탭 삽입).
  useLayoutEffect(() => {
    if (caretRef.current != null && taRef.current) {
      taRef.current.setSelectionRange(caretRef.current, caretRef.current)
      caretRef.current = null
    }
  }, [text])

  // 요청 목록에서 고른 요청으로 커서를 옮긴다.
  useLayoutEffect(() => {
    if (!scrollToLine) return
    const ta = taRef.current
    if (!ta) return
    const ls = ta.value.split("\n")
    let pos = 0
    for (let i = 0; i < Math.min(scrollToLine.line, ls.length); i++)
      pos += ls[i].length + 1
    ta.focus()
    ta.setSelectionRange(pos, pos)
    onCaretLine(scrollToLine.line)
    // 해당 줄이 화면 위쪽에 오도록 컨테이너를 굴린다.
    const box = ta.closest("[data-http-scroll]")
    if (box instanceof HTMLElement) {
      const top = scrollToLine.line * LINE_H
      if (
        top < box.scrollTop ||
        top > box.scrollTop + box.clientHeight - LINE_H * 3
      )
        box.scrollTop = Math.max(0, top - LINE_H * 2)
    }
    // onCaretLine 은 매 렌더 새로 오지만 이 효과는 seq 가 바뀔 때만 돌아야 한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToLine?.seq])

  const syncCaret = () => {
    const ta = taRef.current
    if (!ta) return
    const line = ta.value.slice(0, ta.selectionStart).split("\n").length - 1
    if (line !== caretLine) onCaretLine(line)
    // 스크롤은 바깥 컨테이너가 하므로(위 주석 3번) 브라우저가 커서를 따라 굴려 주지
    // 않는다. 커서가 화면 밖으로 나갔을 때만 최소한으로 맞춘다 — 사용자가 직접 굴린
    // 스크롤을 되돌리지 않도록 "밖으로 나갔을 때만"이 중요하다.
    const box = ta.closest("[data-http-scroll]")
    if (!(box instanceof HTMLElement)) return
    const top = line * LINE_H
    const bottom = top + LINE_H + PAD_Y * 2
    if (top < box.scrollTop) box.scrollTop = top
    else if (bottom > box.scrollTop + box.clientHeight)
      box.scrollTop = bottom - box.clientHeight
  }

  const setValueCaret = (v: string, caret: number) => {
    caretRef.current = caret
    onChange(v)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = taRef.current
    if (!ta) return
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key === "s") {
      e.preventDefault()
      onSave()
      return
    }
    if (mod && e.key === "Enter") {
      e.preventDefault()
      const line = ta.value.slice(0, ta.selectionStart).split("\n").length - 1
      const target = [...requests]
        .reverse()
        .find((r) => r.startLine <= line && line <= r.endLine)
      if (target) onRun(target)
      return
    }
    if (e.key === "Tab") {
      e.preventDefault()
      const s = ta.selectionStart
      const eSel = ta.selectionEnd
      setValueCaret(ta.value.slice(0, s) + "  " + ta.value.slice(eSel), s + 2)
      return
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      // 앞 줄의 들여쓰기를 이어 준다(JSON 본문 편집이 대부분이다).
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
    <div
      data-http-scroll
      className="relative min-h-0 flex-1 overflow-auto rounded-[10px] border border-border bg-background shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
    >
      <div className="flex" style={{ minWidth: "100%", height }}>
        {/* 거터 — 줄 번호, 요청이 시작하는 줄에는 ▶ */}
        <div
          className="sticky left-0 z-10 shrink-0 border-r border-border bg-muted/40 select-none"
          style={{ width: GUTTER, paddingTop: PAD_Y }}
        >
          {lines.map((_, i) => {
            const req = runnable.get(i)
            const busy = req ? runningIndexes.has(req.index) : false
            return (
              <div
                key={i}
                className="flex items-center justify-end gap-1 pr-1.5"
                style={{ height: LINE_H }}
              >
                {req ? (
                  <button
                    type="button"
                    onClick={() => onRun(req)}
                    disabled={busy}
                    title={`실행 — ${requestLabel(req)}`}
                    className={cn(
                      "flex size-4 items-center justify-center rounded-full transition-colors",
                      req.index === activeIndex
                        ? "text-ui-success hover:bg-ui-success/15"
                        : "text-muted-foreground hover:bg-ui-list-hover hover:text-ui-success"
                    )}
                  >
                    {busy ? (
                      <Loader2Icon className="size-3 animate-spin" />
                    ) : (
                      <PlayIcon className="size-3 fill-current" />
                    )}
                  </button>
                ) : (
                  <span className="text-[10px] text-muted-foreground/60 tabular-nums">
                    {i + 1}
                  </span>
                )}
              </div>
            )
          })}
        </div>

        <div className="relative" style={{ minWidth: "max-content", flex: 1 }}>
          {/*
            `select-none` 이 필수다. 이 `<pre>` 는 눈에 보이는 글자를 그리는 층이고,
            텍스트를 **고르는** 층은 위에 겹친 textarea 다. 여기가 선택 가능하면
            거터에서 시작한 드래그나 편집기 밖에서 누른 ⌘A 가 이 `<pre>` 를 잡아,
            글자 뒤에 파란 띠가 깔린 채 남는다 — 아무것도 선택하지 않았는데 "전체
            선택된 것처럼" 보이는 상태이고, 클릭해도 지워지지 않아 고장으로 읽힌다.
          */}
          <pre
            aria-hidden
            className="pointer-events-none m-0 overflow-hidden break-normal whitespace-pre text-foreground select-none"
            style={FONT}
            dangerouslySetInnerHTML={{ __html: html + "\n" }}
          />
          <textarea
            ref={taRef}
            value={text}
            wrap="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => {
              onChange(e.target.value)
              requestAnimationFrame(syncCaret)
            }}
            onKeyDown={onKeyDown}
            onKeyUp={syncCaret}
            onClick={syncCaret}
            onSelect={syncCaret}
            /*
              선택 배경은 **반투명**이어야 한다. 이 textarea 의 글자는 투명하고 실제
              글자는 아래 `<pre>` 가 그리므로, 불투명한 기본 선택색을 쓰면 드래그한
              범위의 글자가 파란 덩어리에 가려 사라진다.
            */
            className="absolute inset-0 size-full resize-none overflow-hidden border-0 bg-transparent whitespace-pre text-transparent caret-foreground outline-none selection:bg-ui-selection/30 selection:text-transparent"
            style={FONT}
          />
        </div>
      </div>
    </div>
  )
}
