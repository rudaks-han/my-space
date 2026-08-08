import { useCallback, useEffect, useRef, useState } from "react"
import { listen } from "@tauri-apps/api/event"

import { isTauri, trackedInvoke } from "@/lib/tauri"
import { imeTrace } from "./ime-trace" // ⚠️ 임시 계측

/** Rust `PtyData` 와 대응. 바이트는 base64 로 온다(아래 `decode` 주석 참고). */
interface PtyDataEvent {
  id: number
  b64: string
}

/** Rust `PtyExit` 와 대응. */
interface PtyExitEvent {
  id: number
}

/**
 * base64 → 바이트. **문자열로 받지 않는 이유**: PTY 읽기 경계는 UTF-8 문자 중간에 떨어질 수
 * 있어서, 조각마다 문자열로 옮기면 그 경계의 글자가 깨진다(한글이 곧바로 깨진다).
 * 바이트로 넘겨 주면 xterm.js 가 스트림 전체를 이어 붙여 디코딩한다.
 */
function decode(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

/** 바이트 → base64. 입력도 같은 이유로 바이트로 보낸다(한글 조합 문자가 그대로 가야 한다). */
function encode(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

const utf8 = new TextEncoder()

export interface PtyHandle {
  /** 열려 있는 PTY id. 아직 안 열렸으면 null. */
  id: number | null
  /** 열기 실패·연결 끊김 사유. 없으면 null. */
  error: string | null
  /** 자식이 종료돼 화면이 멈췄는가(다시 연결 버튼을 띄우는 조건). */
  exited: boolean
  open: (session: string, cols: number, rows: number) => Promise<void>
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  close: () => void
}

/**
 * PTY 하나의 생애를 관리한다. 데이터는 콜백으로 흘려보낸다 — state 에 쌓으면 프레임마다
 * 리렌더가 나고(herdr 는 전체 화면을 통째로 보낸다, 실측 최초 프레임 ≈ 59KB) xterm.js 가
 * 이미 자기 버퍼를 들고 있으므로 React 가 같은 것을 두 번 들고 있을 이유가 없다.
 *
 * @param onData PTY 가 뱉은 바이트. xterm 의 `write` 에 그대로 넘기면 된다.
 * @param onExit 자식(herdr 클라이언트)이 끝났을 때.
 */
export function usePty(
  onData: (bytes: Uint8Array) => void,
  onExit?: () => void
): PtyHandle {
  const [id, setId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exited, setExited] = useState(false)

  /*
   * 이벤트 리스너와 커맨드가 동기로 읽어야 하는 값들이라 ref 다. 특히 `idRef` 는 이벤트가
   * 우리 PTY 것인지 가려내는 데 쓰이는데(모든 창이 같은 `pty:data` 를 받는다), 클로저의
   * state 를 보면 낡은 값이라 방금 연 PTY 의 첫 프레임을 놓친다.
   */
  const idRef = useRef<number | null>(null)
  /** 아직 보내지 못한 입력. 순서를 지키려고 한 곳에 모은다(`write` 주석 참고). */
  const bufRef = useRef("")
  /** 지금 쓰기가 진행 중인가. 진행 중이면 버퍼에만 쌓고 그 루프가 이어서 보낸다. */
  const flushingRef = useRef(false)
  // 초기값으로 첫 렌더의 콜백을 잡아 두고, 이후 갱신은 effect 에서 한다 — 렌더 중 ref 에
  // 쓰는 것은 react-hooks/refs 위반이다.
  const onDataRef = useRef(onData)
  const onExitRef = useRef(onExit)
  useEffect(() => {
    onDataRef.current = onData
    onExitRef.current = onExit
  }, [onData, onExit])

  useEffect(() => {
    if (!isTauri()) return
    const unData = listen<PtyDataEvent>("pty:data", (e) => {
      if (e.payload.id !== idRef.current) return
      onDataRef.current(decode(e.payload.b64))
    })
    const unExit = listen<PtyExitEvent>("pty:exit", (e) => {
      if (e.payload.id !== idRef.current) return
      idRef.current = null
      setId(null)
      setExited(true)
      onExitRef.current?.()
    })
    return () => {
      void unData.then((f) => f())
      void unExit.then((f) => f())
    }
  }, [])

  const close = useCallback(() => {
    const cur = idRef.current
    idRef.current = null
    bufRef.current = ""
    setId(null)
    if (cur !== null) void trackedInvoke("pty_close", { id: cur })
  }, [])

  const open = useCallback(
    async (session: string, cols: number, rows: number) => {
      if (!isTauri()) {
        setError("데스크톱 앱에서만 동작합니다.")
        return
      }
      // 이전 것이 남아 있으면 먼저 닫는다 — 세션을 바꿀 때 herdr 클라이언트가 둘 붙는다.
      const prev = idRef.current
      idRef.current = null
      // 앞 세션에 못 보낸 입력이 새 세션으로 흘러가면 안 된다.
      bufRef.current = ""
      if (prev !== null) void trackedInvoke("pty_close", { id: prev })
      setError(null)
      setExited(false)
      try {
        const next = await trackedInvoke<number>("pty_open", {
          session,
          cols,
          rows,
        })
        // 리스너가 곧바로 걸러 낼 수 있도록 ref 를 먼저 채운다(첫 프레임이 즉시 온다).
        idRef.current = next
        setId(next)
      } catch (e) {
        setError(String(e))
      }
    },
    []
  )

  /**
   * PTY 에 입력을 쓴다. **한 번에 하나씩, 넣은 순서대로** 보낸다.
   *
   * 여기서 `void trackedInvoke(...)` 로 바로 던지면 안 된다 — Tauri IPC 호출은 서로 독립된
   * 약속이라 **도착 순서가 보장되지 않는다.** 평범한 영문 타이핑은 키 사이 간격이 있어 잘
   * 드러나지 않지만, 한글 IME 는 한 키에 여러 `input` 이벤트를 연달아 내고(`ime.ts`) 그중
   * 지우기(`DEL`)가 섞여 있어서, 순서가 한 번 뒤집히면 **DEL 이 먼저 들어온 다음 음절을
   * 지운다.** 실제 증상이 그것이었다: "되는지" 가 "는" 만 남고 "확인해" 가 "확해" 가 되는 식으로
   * **음절이 통째로 사라지고, 사라진 것마다 바로 뒤 음절은 남아 있었다.**
   *
   * 그래서 보낼 것을 버퍼에 모으고, 앞의 호출이 끝난 뒤에만 다음을 보낸다. 기다리는 동안
   * 들어온 입력은 한 덩어리로 합쳐지므로 호출 수도 줄어든다(빠른 타이핑·붙여넣기에서 유리).
   */
  const write = useCallback((data: string) => {
    if (!data) return
    bufRef.current += data
    if (flushingRef.current) return
    flushingRef.current = true
    void (async () => {
      try {
        while (bufRef.current) {
          const chunk = bufRef.current
          bufRef.current = ""
          const cur = idRef.current
          if (cur === null) return
          imeTrace(`write ${JSON.stringify(chunk)}`)
          await trackedInvoke("pty_write", {
            id: cur,
            b64: encode(utf8.encode(chunk)),
          })
        }
      } catch (e) {
        setError(String(e))
      } finally {
        flushingRef.current = false
      }
    })()
  }, [])

  const resize = useCallback((cols: number, rows: number) => {
    const cur = idRef.current
    if (cur === null) return
    void trackedInvoke("pty_resize", { id: cur, cols, rows }).catch(() => {
      /* 크기 변경 실패는 화면을 못 쓰게 만들지 않으므로 조용히 넘긴다. */
    })
  }, [])

  // 탭을 닫아 뷰가 언마운트되면 herdr 클라이언트를 떼어 낸다(세션 자체는 계속 돈다).
  useEffect(() => close, [close])

  return { id, error, exited, open, write, resize, close }
}
