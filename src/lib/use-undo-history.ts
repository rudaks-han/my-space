/**
 * 겹친 `<textarea>` 편집기의 **되돌리기(⌘Z) · 다시 실행(⌘⇧Z)**.
 *
 * 웹뷰가 textarea 에 붙여 주는 기본 되돌리기는 여기서 쓸 수 없다. 이 편집기들은 값을
 * React 가 쥔 **제어 컴포넌트**라, 값이 바뀔 때마다 React 가 `node.value` 를 직접 써넣고
 * WebKit 은 그 순간 자기 undo 스택을 버린다. 탭·자동 들여쓰기처럼 코드가 값을 갈아끼우는
 * 경로는 더 확실히 지운다. 그래서 이력을 우리가 들고 있는다.
 *
 * 세 가지가 이 훅의 모양을 정한다:
 *
 * - **기록 시점은 `beforeinput` 이고, 반드시 네이티브로 붙인다.** 그때만 "바뀌기 직전의
 *   커서"를 알 수 있고(`input` 이후에는 이미 옮겨져 있다), 타자·붙여넣기·지우기·드롭·
 *   IME 확정이 모두 이 하나로 들어온다. 바뀌기 직전의 **본문**은 받아 둘 필요가 없다 —
 *   `text` prop 이 곧 그것이다. React 의 `onBeforeInput` 을 쓰면 안 되는데, 그것은 이름만
 *   같은 **옛 폴리필**이라(`keypress`·`textInput`·`paste`·`compositionend` 로 합성한다)
 *   `inputType` 이 없고 **지우기에는 아예 오지 않는다** — 백스페이스가 한 단계도 남지
 *   않아 ⌘Z 가 지운 글자를 건너뛴다.
 * - **이어 친 글자만 한 단계로 묶는다.** 한 글자에 한 단계면 ⌘Z 를 수십 번 눌러야 하고,
 *   전부 묶으면 어디까지 되돌아갈지 알 수 없다. 그래서 `insertText` 가 `MERGE_MS` 안에
 *   이어질 때만 묶고 줄바꿈·붙여넣기·지우기·손을 멈춘 뒤의 타자는 각각 한 단계로 둔다.
 * - **밖에서 본문이 갈아끼워지면 이력을 버린다.** 툴바의 새로고침은 디스크 내용으로
 *   되돌리는 조작인데, 그때 이력이 남아 있으면 ⌘Z 가 방금 버린 편집을 되살리고 파일이
 *   다시 수정 상태가 된다. "우리가 만든 변경인지"는 `self` 플래그로 가른다.
 */

import { useCallback, useEffect, useRef } from "react"

/** 되돌릴 수 있는 단계 수. 한 단계는 스냅숏 하나(본문 전체)라 무한정 쌓지 않는다. */
const LIMIT = 200
/** 이보다 빨리 이어 친 글자는 앞 단계에 묶는다. 손을 멈추면 거기서 단계가 갈린다. */
const MERGE_MS = 500

interface Step {
  text: string
  /** 되돌렸을 때 커서를 놓을 자리 — 바뀌기 **직전**의 위치다. */
  caret: number
}

export interface UndoHistory {
  /**
   * 코드가 직접 값을 갈아끼우기 **직전**에 부른다(탭 삽입·자동 들여쓰기).
   * 묶지 않으므로 그 한 번이 곧 한 단계가 된다.
   */
  capture: (caret: number) => void
  /** ⌘Z / ⌘⇧Z / ⌃Y 를 처리한다. 처리했으면 `true` — 호출부는 거기서 멈춘다. */
  handleKey: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
}

export function useUndoHistory({
  taRef,
  text,
  onChange,
  setCaret,
  readOnly = false,
}: {
  /** 편집기의 textarea — 여기에 네이티브 `beforeinput` 을 붙인다. */
  taRef: React.RefObject<HTMLTextAreaElement | null>
  /** 지금 편집기에 떠 있는 본문. 기록할 "직전 본문"이 바로 이 값이다. */
  text: string
  onChange: (v: string) => void
  /** 되돌린 뒤 커서를 놓을 자리. 편집기의 `caretRef` 에 적어 두면 된다. */
  setCaret: (n: number) => void
  readOnly?: boolean
}): UndoHistory {
  const past = useRef<Step[]>([])
  const future = useRef<Step[]>([])
  /** 렌더 중에 읽지 않는다 — 이벤트 핸들러에서만 쓰는 "현재 본문". */
  const textRef = useRef(text)
  /** 방금 온 본문 변경이 우리가 만든 것인가. */
  const self = useRef(false)
  const lastAt = useRef(0)
  /** 앞 단계가 "이어 칠 수 있는" 타자였는가(묶음 판정의 절반). */
  const lastMergeable = useRef(false)

  useEffect(() => {
    if (self.current) self.current = false
    else {
      // 밖에서 갈아끼워진 본문(툴바 새로고침·파일 교체)이다.
      past.current = []
      future.current = []
      lastMergeable.current = false
    }
    textRef.current = text
  }, [text])

  const push = useCallback((caret: number, mergeable: boolean) => {
    const now = Date.now()
    const merge =
      mergeable &&
      lastMergeable.current &&
      past.current.length > 0 &&
      now - lastAt.current < MERGE_MS
    lastAt.current = now
    lastMergeable.current = mergeable
    self.current = true
    // 새 편집이 들어오면 "다시 실행할 미래"는 사라진다 — 묶이는 경우에도 마찬가지다.
    future.current = []
    if (merge) return
    past.current.push({ text: textRef.current, caret })
    if (past.current.length > LIMIT) past.current.shift()
  }, [])

  useEffect(() => {
    const ta = taRef.current
    if (!ta || readOnly) return
    const onBefore = (e: Event) => {
      const ne = e as InputEvent
      const type = ne.inputType
      const mergeable =
        // 조합 중인 글자(한글·일본어)는 자모마다 이벤트가 온다 — 묶지 않으면 "한" 한
        // 글자를 되돌리는 데 ⌘Z 를 세 번 눌러야 한다. 조합은 커서 자리가 범위로 잡히기도
        // 하므로 아래의 접힘(collapsed) 조건도 걸지 않는다.
        type === "insertCompositionText" ||
        type === "deleteCompositionText" ||
        (type === "insertText" &&
          typeof ne.data === "string" &&
          ne.data !== "" &&
          !ne.data.includes("\n") &&
          // 범위를 고른 채 친 글자는 "지우고 넣기"라, 앞 타자와 묶으면 둘이 함께 되돌아간다.
          ta.selectionStart === ta.selectionEnd)
      push(ta.selectionStart, mergeable)
    }
    ta.addEventListener("beforeinput", onBefore)
    return () => ta.removeEventListener("beforeinput", onBefore)
  }, [taRef, push, readOnly])

  const capture = useCallback((caret: number) => push(caret, false), [push])

  const step = useCallback(
    (
      from: React.RefObject<Step[]>,
      to: React.RefObject<Step[]>,
      ta: HTMLTextAreaElement
    ) => {
      const s = from.current.pop()
      if (!s) return
      to.current.push({ text: textRef.current, caret: ta.selectionStart })
      // 되돌린 직후에 친 글자가 되돌리기 전 타자와 묶이면 안 된다.
      lastMergeable.current = false
      self.current = true
      setCaret(s.caret)
      onChange(s.text)
    },
    [onChange, setCaret]
  )

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return false
      const k = e.key.toLowerCase()
      const undo = k === "z" && !e.shiftKey
      const redo = (k === "z" && e.shiftKey) || k === "y"
      if (!undo && !redo) return false
      // 읽기 전용이어도 기본 동작은 막는다 — 웹뷰의 되돌리기가 편집기 밖(예: 방금 고친
      // 입력칸)에 끼어들면 어디가 되돌아갔는지 알 수 없다.
      e.preventDefault()
      if (readOnly) return true
      if (redo) step(future, past, e.currentTarget)
      else step(past, future, e.currentTarget)
      return true
    },
    [step, readOnly]
  )

  return { capture, handleKey }
}
