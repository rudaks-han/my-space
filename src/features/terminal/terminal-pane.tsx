import { useEffect, useRef, useState } from "react"
import { FitAddon } from "@xterm/addon-fit"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { Terminal } from "@xterm/xterm"
import { RotateCcwIcon } from "lucide-react"

import "@xterm/xterm/css/xterm.css"

import { cn } from "@/lib/utils"
import { installImeFix } from "./ime"
import { usePty } from "./use-pty"

/** 글자 크기 범위. 터미널은 열 수가 글자 폭으로 정해지므로 이 값이 곧 화면 정보량이다. */
export const TERMINAL_FONT_MIN = 10
export const TERMINAL_FONT_MAX = 22
export const TERMINAL_FONT_DEFAULT = 13

/**
 * 크기 변경을 herdr 에 알리기까지 두는 간격(ms). 창을 드래그로 늘이는 동안 매 프레임
 * `pty_resize` 를 부르면 herdr 가 그만큼 전체 화면을 다시 그려 보낸다(프레임 하나가 수십 KB).
 */
const RESIZE_DEBOUNCE = 120

/** xterm 팔레트를 CSS 변수에서 읽어 온다. 값의 출처는 `--console-*`(index.css) 하나다. */
function readTheme(el: HTMLElement) {
  const s = getComputedStyle(el)
  const v = (name: string, fallback: string) =>
    s.getPropertyValue(name).trim() || fallback
  return {
    // herdr TUI 가 화면 전체를 자기 색으로 칠하므로 이 배경은 첫 프레임 전과 여백에만 보인다.
    background: "#1A1D21",
    foreground: v("--console-br-white", "#FFFFFF"),
    cursor: v("--console-br-white", "#FFFFFF"),
    selectionBackground: "#FFFFFF40",
    black: v("--console-black", "#000000"),
    red: v("--console-red", "#FF6B68"),
    green: v("--console-green", "#A8C023"),
    yellow: v("--console-yellow", "#D6BF55"),
    blue: v("--console-blue", "#5394EC"),
    magenta: v("--console-magenta", "#AE8ABE"),
    cyan: v("--console-cyan", "#299999"),
    white: v("--console-white", "#999999"),
    brightBlack: v("--console-br-black", "#555555"),
    brightRed: v("--console-br-red", "#FF8785"),
    brightGreen: v("--console-br-green", "#A8C023"),
    brightYellow: v("--console-br-yellow", "#FFFF00"),
    brightBlue: v("--console-br-blue", "#7EAEF1"),
    brightMagenta: v("--console-br-magenta", "#FF99FF"),
    brightCyan: v("--console-br-cyan", "#6CDADA"),
    brightWhite: v("--console-br-white", "#FFFFFF"),
  }
}

/** 부모(툴바)가 그리고 싶어 하는 연결 상태. */
export interface TerminalPaneStatus {
  /** PTY 가 붙어 있는가. */
  connected: boolean
  cols: number
  rows: number
}

export interface TerminalPaneProps {
  /** 붙을 herdr 세션 이름. 바뀌면 앞의 PTY 를 닫고 다시 붙는다. 빈 값이면 붙지 않는다. */
  session: string
  fontSize?: number
  /** 터미널 박스에 얹을 클래스(크기·모서리는 부모가 정한다). */
  className?: string
  /**
   * 붙기 **직전에** 한 번 실행할 준비 작업. 세션 목록 상세가 여기서
   * `herdr_select_workspace` 를 부른다 — 붙은 뒤에 부르면 첫 프레임이 엉뚱한 워크스페이스라
   * 화면이 한 번 깜빡인다. 실패해도 붙기는 계속한다(사용자가 herdr 안에서 옮기면 된다).
   *
   * 매 렌더 새 함수여도 되도록 ref 로 잡는다 — 의존성에 넣으면 렌더마다 재attach 된다.
   */
  prepare?: () => Promise<void>
  /** 연결 상태 변화 통지(툴바에 "연결됨 100×30" 을 그리기 위한 것). */
  onStatus?: (s: TerminalPaneStatus) => void
  /** 붙은 뒤 키보드 포커스를 가져올지. 기본 true(바로 방향키를 쓰려면 필요하다). */
  autoFocus?: boolean
}

/**
 * herdr 세션에 **진짜 터미널로** 붙는 한 칸.
 *
 * 우리가 만든 PTY 안에서 `herdr session attach` 를 돌리고 그 바이트를 xterm.js 에 그대로
 * 흘려보낸다(`src-tauri/src/pty.rs` 헤더에 실측 근거가 있다). 그래서 커서·색·한글 IME·
 * 리사이즈가 전부 herdr 와 xterm.js 사이에서 해결되고, 구조화된 컨트롤이 다루지 못하는
 * 폼(AskUserQuestion 의 방향키 선택, 권한 프롬프트, 모델 선택, Esc 취소)도 그냥 된다.
 *
 * **전용 뷰(`terminal-view.tsx`)와 세션 목록 상세 패널이 이 컴포넌트를 공유한다.** xterm 을
 * 두 곳에서 각자 만들면 IME 우회(`ime.ts`)와 unicode11 문자폭 설정 같은 규칙이 두 벌이 되고,
 * 그중 한쪽만 고쳐지는 것이 이 저장소가 반복해 부딪힌 함정이다. 그래서 상태 표시(오류 배너·
 * 다시 연결)까지 여기서 소유하고, 부모는 `onStatus` 로 받은 크기만 툴바에 그린다.
 */
export function TerminalPane({
  session,
  fontSize = TERMINAL_FONT_DEFAULT,
  className,
  prepare,
  onStatus,
  autoFocus = true,
}: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  /*
   * 마지막으로 herdr 에 알린 크기. ResizeObserver 콜백이 "같은 값이면 보내지 않는다"를
   * 동기로 판정해야 해서 ref 이고, 툴바에 숫자를 올리려면 state 도 필요하다.
   */
  const sizeRef = useRef({ cols: 0, rows: 0 })
  const [size, setSize] = useState({ cols: 0, rows: 0 })

  const pty = usePty((bytes) => termRef.current?.write(bytes))

  // 렌더마다 새 함수로 와도 재attach·재구독이 나지 않도록 최신값만 ref 에 담아 둔다.
  const prepareRef = useRef(prepare)
  const onStatusRef = useRef(onStatus)
  const autoFocusRef = useRef(autoFocus)
  useEffect(() => {
    prepareRef.current = prepare
    onStatusRef.current = onStatus
    autoFocusRef.current = autoFocus
  }, [prepare, onStatus, autoFocus])

  // xterm 을 한 번 만들고 이 칸이 살아 있는 동안 유지한다.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      fontFamily:
        "'SF Mono', ui-monospace, Menlo, Monaco, 'Courier New', monospace",
      fontSize,
      // herdr 가 커서 모양을 직접 지정하므로 여기서는 기본값만 준다.
      cursorBlink: true,
      // 스크롤백은 herdr 가 자기 화면 안에서 관리한다(copy mode). 우리 쪽에 쌓으면
      // 전체 화면 프레임이 그대로 히스토리가 되어 위로 올려도 뜻이 없는 화면만 나온다.
      scrollback: 0,
      allowProposedApi: true,
      theme: readTheme(host),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    /*
     * 한글·CJK 는 두 칸을 차지하는데, 그 판단표(문자 폭)가 herdr 쪽과 어긋나면 줄이 밀려
     * 화면이 어긋난다. xterm 의 기본 표는 오래된 유니코드 버전이므로 최신 표로 갈아 끼운다 —
     * `activeVersion` 을 지정하지 않으면 애드온을 올려도 기본 표가 계속 쓰인다.
     */
    const unicode11 = new Unicode11Addon()
    term.loadAddon(unicode11)
    term.unicode.activeVersion = "11"
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    const onData = term.onData((d) => pty.write(d))
    // 붙여넣기·IME 확정 등 바이트로 오는 입력.
    const onBinary = term.onBinary((d) => pty.write(d))
    // 한글(IME) 조합을 WebKit 에서 쓸 수 있게 메운다 — 왜 필요한지는 `ime.ts` 헤더에.
    const detachIme = installImeFix(term, host)
    return () => {
      detachIme()
      onData.dispose()
      onBinary.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // 글자 크기·PTY 핸들 변화로 터미널을 새로 만들지 않는다(각각 아래 effect 가 반영한다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 글자 크기 변경 → 즉시 반영 + 열/행 재계산.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fontSize
    fitRef.current?.fit()
  }, [fontSize])

  /*
   * 컨테이너 크기 변화 → `fit()` → herdr 에 새 크기 통보. 탭이 비활성일 때는 `invisible`
   * (visibility:hidden)이라 레이아웃이 그대로 남아 측정이 되므로 별도 처리가 필요 없다 —
   * `hidden`/`display:none` 이었다면 0×0 으로 측정돼 터미널이 찌그러졌을 것이다.
   */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let timer: number | undefined
    const apply = () => {
      const fit = fitRef.current
      const term = termRef.current
      if (!fit || !term) return
      fit.fit()
      const { cols, rows } = term
      if (cols === sizeRef.current.cols && rows === sizeRef.current.rows) return
      sizeRef.current = { cols, rows }
      setSize({ cols, rows })
      pty.resize(cols, rows)
    }
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(apply, RESIZE_DEBOUNCE)
    })
    ro.observe(host)
    apply()
    return () => {
      window.clearTimeout(timer)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pty.resize])

  /*
   * 세션이 정해지면 붙는다. 세션을 바꾸면 `open` 이 앞의 PTY 를 먼저 닫으므로 herdr
   * 클라이언트가 둘 붙는 일은 없다. 화면도 함께 비운다 — 안 비우면 앞 세션의 프레임 위에
   * 새 세션의 프레임이 겹쳐 그려져 두 화면이 섞인 것처럼 보인다.
   */
  useEffect(() => {
    if (!session) return
    const term = termRef.current
    if (!term) return
    term.reset()
    const cols = term.cols || 80
    const rows = term.rows || 24
    sizeRef.current = { cols, rows }
    let cancelled = false
    void (async () => {
      // 준비 작업(워크스페이스 선택)을 먼저 — 실패해도 붙기는 계속한다.
      try {
        await prepareRef.current?.()
      } catch (e) {
        console.error("터미널 준비 작업 실패:", e)
      }
      // 기다리는 동안 세션이 또 바뀌었으면 그쪽 effect 가 붙는다.
      if (cancelled) return
      await pty.open(session, cols, rows)
      if (!cancelled && autoFocusRef.current) term.focus()
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  // 연결 상태를 부모에게 알린다(툴바의 "연결됨 100×30" 칩).
  useEffect(() => {
    onStatusRef.current?.({
      connected: pty.id !== null,
      cols: size.cols,
      rows: size.rows,
    })
  }, [pty.id, size])

  const reconnect = () => {
    const term = termRef.current
    if (!term || !session) return
    term.reset()
    void pty.open(session, term.cols || 80, term.rows || 24).then(() => {
      if (autoFocusRef.current) term.focus()
    })
  }

  return (
    /*
     * `dark` 클래스가 붙어 있는 이유: `--console-*` 팔레트가 `.dark` 아래에 Darcula 값으로
     * 정의돼 있고, 터미널은 프리셋·라이트/다크와 무관하게 항상 어두운 표면이다
     * (세션 목록의 `.claude-log` 와 같은 판단). 값을 여기에 다시 적지 않고 클래스로
     * 끌어오면 팔레트의 출처가 index.css 한 곳으로 남는다.
     */
    <div
      className={cn(
        "dark relative min-h-0 overflow-hidden bg-[#1A1D21] p-2",
        className
      )}
    >
      <div ref={hostRef} className="size-full" />

      {/*
       * 오류와 "다시 연결" 은 터미널 위에 겹쳐 띄운다. 부모의 툴바에 두면 상세 패널처럼
       * 툴바가 없는 자리에서는 갈 곳이 없고, 같은 상태를 두 화면이 다르게 그리게 된다.
       */}
      {pty.error && (
        <p className="absolute inset-x-2 top-2 rounded-lg bg-ui-error/90 px-3 py-2 text-[13px] text-white">
          {pty.error}
        </p>
      )}
      {pty.exited && (
        <button
          type="button"
          onClick={reconnect}
          className="absolute top-3 right-3 inline-flex cursor-pointer items-center gap-1 rounded-full border border-white/25 bg-black/80 px-2.5 py-1 text-[11px] font-bold text-white transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid"
        >
          <RotateCcwIcon className="size-3" />
          연결 끊김 · 다시 연결
        </button>
      )}
    </div>
  )
}
