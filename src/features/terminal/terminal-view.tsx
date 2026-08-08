import { useCallback, useEffect, useState } from "react"
import {
  CircleAlertIcon,
  MinusIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { isTauri, trackedInvoke } from "@/lib/tauri"
import { useLocalStorage } from "@/lib/use-local-storage"
import {
  TerminalPane,
  TERMINAL_FONT_DEFAULT,
  TERMINAL_FONT_MAX,
  TERMINAL_FONT_MIN,
  type TerminalPaneStatus,
} from "./terminal-pane"
import {
  clearTerminalSessionRequest,
  useTerminalSessionRequest,
} from "./terminal-target"

/**
 * 터미널 뷰 — herdr 세션에 **진짜 터미널로** 붙는다.
 *
 * 붙는 일 자체는 `TerminalPane` 이 한다(세션 목록 상세 패널의 「터미널」 탭과 공유하는
 * 컴포넌트다). 이 화면이 더하는 것은 세션 선택·글자 크기 툴바와, 아래 두 가지 안내다.
 *
 * **(1) 실제 터미널과 보고 있는 화면이 공유된다** — herdr 의 포커스는 서버 상태라 여기서
 * 워크스페이스를 옮기면 사용자의 실제 터미널도 따라 옮겨 간다(실측: `workspace focus` 후 두
 * 클라이언트가 바이트 수까지 같은 프레임을 받는다). 적어 두지 않으면 왜 터미널이 저절로
 * 움직이는지 알 수 없다. **(2) 크기는 각자다** — 이쪽이 좁아도 실제 터미널은 줄어들지
 * 않는다(tmux 와 다르다). 그 둘을 헷갈리면 이 화면을 열기가 무서워진다.
 */
export function TerminalView() {
  const [sessions, setSessions] = useState<string[]>([])
  const [session, setSession] = useLocalStorage<string>(
    "myspace.terminalSession",
    ""
  )
  const [fontSize, setFontSize] = useLocalStorage<number>(
    "myspace.terminalFontSize",
    TERMINAL_FONT_DEFAULT
  )
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<TerminalPaneStatus>({
    connected: false,
    cols: 0,
    rows: 0,
  })

  /*
   * 붙을 수 있는 세션 목록. herdr 전용이라 비어 있는 경우가 정상이고(설치 안 함, 데몬 미실행,
   * cmux·Orca 만 사용), 그때는 안내를 띄운다 — 빈 검은 화면은 고장으로 읽힌다.
   */
  const loadSessions = useCallback(async () => {
    // setState 는 모두 await 뒤에서만 한다(effect 에서 바로 불려도 동기 setState 가 되지
    // 않도록 — react-hooks/set-state-in-effect). useHerdr 도 같은 규칙이다.
    const list = await (isTauri()
      ? trackedInvoke<string[]>("herdr_attachable_sessions").catch(
          () => [] as string[]
        )
      : Promise.resolve([] as string[]))
    setSessions(list)
    setLoading(false)
    // 저장된 선택이 사라졌으면(세션 종료) 첫 번째로 옮긴다 — 여기서 조용히 비워 두면
    // 화면이 아무 이유 없이 빈 상태로 남는다.
    setSession((prev) => (prev && list.includes(prev) ? prev : (list[0] ?? "")))
  }, [setSession])

  useEffect(() => {
    // 실제 setState 는 모두 await 뒤에서 일어나므로 cascading render 가 아니다.
    // 규칙은 effect 본문에서 호출한다는 사실만 보고 잡는다(저장소 다른 곳도 이 형태다).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSessions()
  }, [loadSessions])

  /*
   * 세션 목록의 「앱 터미널에서 열기」가 넘긴 요청을 받는다. 목록에 없는 이름이면(그 사이
   * 세션이 끝났다) 무시하되 요청은 비운다 — 남겨 두면 드롭다운으로 다른 세션을 고를 때마다
   * 이 값이 선택을 되돌려 놓는다.
   */
  const requested = useTerminalSessionRequest()
  useEffect(() => {
    if (!requested) return
    if (sessions.includes(requested)) setSession(requested)
    clearTerminalSessionRequest()
  }, [requested, sessions, setSession])

  const noSession = !loading && sessions.length === 0

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* 툴바 — 세션 선택 · 글자 크기 · 새로고침. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          세션
          <select
            value={session}
            onChange={(e) => setSession(e.target.value)}
            disabled={sessions.length === 0}
            className="h-8 rounded-lg border border-input bg-background px-2 text-[15px] disabled:opacity-50"
          >
            {sessions.length === 0 && <option value="">(없음)</option>}
            {sessions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-1">
          <button
            type="button"
            title="글자 작게"
            onClick={() =>
              setFontSize((n) => Math.max(TERMINAL_FONT_MIN, n - 1))
            }
            className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <MinusIcon className="size-3.5" />
          </button>
          <span className="min-w-8 text-center text-[13px] text-muted-foreground tabular-nums">
            {fontSize}px
          </span>
          <button
            type="button"
            title="글자 크게"
            onClick={() =>
              setFontSize((n) => Math.min(TERMINAL_FONT_MAX, n + 1))
            }
            className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <PlusIcon className="size-3.5" />
          </button>
        </div>

        {status.connected && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-ui-success/15 px-2.5 py-0.5 text-[11px] font-bold text-ui-success">
            <span className="inline-block size-1.5 rounded-full bg-current" />
            연결됨 {status.cols}×{status.rows}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="rounded-full"
            onClick={() => void loadSessions()}
          >
            <RefreshCwIcon className="size-3.5" />
            세션 새로고침
          </Button>
        </div>
      </div>

      {/*
       * 공유 사실 안내. 이건 장식이 아니라 이 화면을 안심하고 쓰기 위한 정보다 — 여기서
       * 워크스페이스를 옮기면 실제 터미널도 따라 움직이는데, 그걸 모르면 고장으로 읽힌다.
       * 반대로 "크기는 각자"라는 사실도 함께 말해야 좁은 패널로 여는 것이 두렵지 않다.
       */}
      <p className="shrink-0 text-[13px] text-muted-foreground">
        실제 터미널과{" "}
        <b className="font-semibold">보고 있는 워크스페이스를 공유</b>
        합니다 — 여기서 옮기면 그쪽도 따라 옮겨 갑니다. 반면{" "}
        <b className="font-semibold">크기는 각자</b>라서 이 창이 좁아도 실제
        터미널은 줄어들지 않습니다. 분리는 <code>ctrl+b</code> 다음{" "}
        <code>q</code>.
      </p>

      {noSession ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-[10px] border border-border bg-card p-8 text-center">
          <CircleAlertIcon className="size-6 text-muted-foreground" />
          <p className="text-[15px] font-bold">붙을 herdr 세션이 없습니다</p>
          <p className="max-w-lg text-[13px] leading-relaxed text-muted-foreground">
            이 화면은 herdr 서버에 클라이언트로 붙는 방식이라 herdr 가 실행
            중이어야 합니다. cmux 는 화면을 평문으로만 주고 attach 개념이 없으며
            Orca 는 IDE 라서, 두 백엔드에는 이 방식이 없습니다 — 그쪽 세션은
            세션 목록 화면에서 다루세요.
          </p>
        </div>
      ) : (
        <TerminalPane
          session={session}
          fontSize={fontSize}
          onStatus={setStatus}
          className="flex-1 rounded-[10px] shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
        />
      )}
    </div>
  )
}
