import { useCallback, useEffect, useMemo, useState } from "react"
import { PlayIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { HttpEditor } from "@/features/intellij-http/http-editor"
import {
  requestAtLine,
  parseHttpFile,
} from "@/features/intellij-http/http-parse"
import { isResolvable, type VarScope } from "@/features/intellij-http/http-vars"
import { ResponsePane } from "@/features/intellij-http/response-pane"
import { responseKey, type useHttpRun } from "./use-http-run"

/**
 * 가운데 탭에 열린 `.http` 파일 하나 — IntelliJ HTTP 편집기를 그대로 쓰되, **응답은
 * 여기 그리지 않는다.**
 *
 * 응답을 탭 안이 아니라 아래 독으로 뺀 이유: 이 화면에는 소스 파일·표·SQL 콘솔 탭이
 * 같이 열리는데, 탭마다 자기 응답 칸을 들면 편집 영역이 탭 종류마다 다른 높이가 된다.
 * 아래 독은 서비스 로그와 같은 자리라 "실행하면 아래를 본다"는 한 가지 습관으로 끝난다.
 * 그래서 이 파일은 편집기(`HttpTab`)와 독의 응답 칸(`HttpResponseDock`) 둘을 내보낸다.
 *
 * 편집·저장 버퍼는 여기 없다. 파일 내용과 dirty 판정은 탭 모델을 든 루트가 소유하고,
 * 이 컴포넌트는 그것을 받아 그리기만 한다 — 소스 파일 탭과 같은 규칙이라야 저장·되돌리기
 * 버튼을 툴바 한 곳에 둘 수 있다.
 */

export function HttpTab({
  path,
  rel,
  text,
  onChange,
  onSave,
  dirty,
  active,
  api,
  onActiveKeyChange,
}: {
  /** `.http` 파일의 절대 경로 — 실행 결과 키와 `< ./include` 의 기준. */
  path: string
  /** 프로젝트 루트 기준 상대 경로(툴팁). */
  rel: string
  text: string
  onChange: (v: string) => void
  onSave: () => void
  dirty: boolean
  /** 지금 보이는 가운데 탭인지. 숨은 탭은 환경 사슬을 가로채지 않는다. */
  active: boolean
  api: ReturnType<typeof useHttpRun>
  /**
   * 커서가 놓인 요청의 결과 키를 루트에 알린다 — 아래 독이 "지금 보는 요청의 응답"을
   * 고를 수 있는 유일한 경로다(커서는 이 컴포넌트만 안다). 안 넘기면 독은 마지막으로
   * 실행한 응답만 보여 준다.
   */
  onActiveKeyChange?: (key: string | null) => void
}) {
  const [caretLine, setCaretLine] = useState(0)

  const parsed = useMemo(() => parseHttpFile(text), [text])
  const activeIndex = requestAtLine(parsed.requests, caretLine)?.index ?? null

  const { loadEnvs } = api

  // 보이는 탭이 환경 사슬의 주인이다 — 환경 파일은 `.http` 파일이 든 폴더에서 위로
  // 거슬러 찾으므로 파일마다 목록이 다르고, 선택 상자는 지금 보는 파일의 것을 보여야 한다.
  useEffect(() => {
    if (!active) return
    void loadEnvs(path)
  }, [active, path, loadEnvs])

  useEffect(() => {
    if (!active) return
    onActiveKeyChange?.(
      activeIndex === null ? null : responseKey(path, activeIndex)
    )
  }, [active, activeIndex, path, onActiveKeyChange])

  /* ── 변수 스코프 — 강조와 실행이 같은 표를 본다 ── */
  const scope: VarScope = useMemo(
    () => ({
      request: {},
      globals: api.globals,
      file: parsed.vars,
      env: api.envVars,
    }),
    [api.globals, parsed.vars, api.envVars]
  )
  const resolveVar = useCallback(
    (name: string) => isResolvable(name, scope),
    [scope]
  )

  /** 이 파일에서 지금 실행 중인 요청 순번들(거터의 스피너). */
  const runningIndexes = useMemo(() => {
    const s = new Set<number>()
    api.running.forEach((k) => {
      if (k.startsWith(`${path}#`)) s.add(Number(k.slice(path.length + 1)))
    })
    return s
  }, [api.running, path])

  const busy = runningIndexes.size > 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 실행 줄 — 위에 툴바와 탭 줄이 이미 있으므로 한 줄 32px 를 넘기지 않는다. */}
      <div className="flex h-8 shrink-0 items-center gap-2 px-1" title={rel}>
        <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">
          요청 {parsed.requests.length}개
        </span>

        <Button
          size="xs"
          onClick={() => void api.runAll(parsed.requests, path)}
          disabled={parsed.requests.length === 0 || busy}
          className="gap-1 text-[12px]"
        >
          <PlayIcon className="size-3 fill-current" />
          전체 실행
        </Button>

        <select
          value={api.envName ?? ""}
          onChange={(e) => api.setEnvName(e.target.value || null)}
          disabled={api.envNames.length === 0}
          title="http-client.env.json 의 환경"
          className="h-6 max-w-40 min-w-0 shrink rounded-lg border border-input bg-transparent px-1.5 text-[12px] outline-none hover:bg-ui-list-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid disabled:opacity-50"
        >
          <option value="">환경 없음</option>
          {api.envNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>

        {api.envError && (
          <span
            className="min-w-0 truncate text-[12px] text-ui-error"
            title={api.envError}
          >
            환경 파일 오류
          </span>
        )}

        <span
          className={cn(
            "ml-auto shrink-0 rounded-full px-2 text-[11px] font-bold",
            dirty
              ? "bg-ui-warning/15 text-ui-warning"
              : "text-transparent select-none"
          )}
        >
          수정됨
        </span>
      </div>

      {/*
        HttpEditor 는 `min-h-0 flex-1` 로 자기 높이를 부모에게서 받고, 스크롤 컨테이너를
        스스로(`data-http-scroll`) 들고 있다 — 여기서 한 겹 더 감싸 스크롤을 주면 거터의
        `sticky left-0` 와 줄 이동이 어긋난다.
      */}
      <HttpEditor
        text={text}
        onChange={onChange}
        requests={parsed.requests}
        resolveVar={resolveVar}
        runningIndexes={runningIndexes}
        activeIndex={activeIndex}
        onRun={(req) => void api.run(req, path)}
        onSave={onSave}
        caretLine={caretLine}
        onCaretLine={setCaretLine}
        scrollToLine={null}
      />
    </div>
  )
}

/**
 * 아래 독의 "HTTP 응답" 칸.
 *
 * 어느 응답을 보여 줄지의 규칙은 IntelliJ HTTP 화면에서 그대로 가져왔다: 커서가 놓인
 * 요청의 결과가 있거나 지금 도는 중이면 그것, 아니면 **마지막으로 실행한 것**. 뒤쪽
 * 대비책이 없으면 방금 실행한 요청에서 커서를 한 줄 옮기는 순간 칸이 비어 버린다.
 */
export function HttpResponseDock({
  api,
  activeKey,
}: {
  api: ReturnType<typeof useHttpRun>
  /** 커서가 놓인 요청의 결과 키. 루트가 `HttpTab` 에게서 받아 넘긴다. */
  activeKey?: string | null
}) {
  const shownKey =
    activeKey && (api.results[activeKey] || api.running.has(activeKey))
      ? activeKey
      : api.lastKey
  const shown = shownKey ? (api.results[shownKey] ?? null) : null
  const shownRunning = shownKey ? api.running.has(shownKey) : false

  // ResponsePane 은 `h-full` 이라 높이를 정해 주는 부모가 필요하다(독이 그 높이를 준다).
  return (
    <div className="h-full overflow-hidden px-2 py-1.5">
      <ResponsePane result={shown} running={shownRunning} />
    </div>
  )
}
