import { useRef, useState } from "react"
import {
  CheckIcon,
  PlayIcon,
  SquareIcon,
  TerminalIcon,
  UndoIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { DataGrid, type GridRow } from "./data-grid"
import * as db from "./db-client"
import type { QueryResponse } from "./db-client"
import { getConsoleSql, setConsoleSql } from "./persisted"

/**
 * 쿼리 콘솔 — 임의 SQL 실행.
 *
 * 두 가지가 IntelliJ 를 따른다: **선택 영역이 있으면 그 부분만 실행**하고(길게 써 둔
 * 스크립트에서 한 문장만 돌리는 흐름), 결과가 여러 개면 전부 보여 준다(세미콜론으로
 * 이어 붙인 문장이나 프로시저 호출은 결과셋과 갱신 건수를 섞어 돌려준다).
 *
 * ⚠️ 여기서 실행한 DML 은 **접속의 커밋 모드를 그대로 따른다.** 자동 커밋이면 즉시
 *    확정되고, 수동 커밋이면 툴바의 커밋을 누를 때까지 열린 트랜잭션에 남는다.
 *    그리드 편집(테이블 탭)과 달리 여기서는 우리가 트랜잭션을 감싸지 않는다 —
 *    사용자가 직접 BEGIN/COMMIT 을 쓸 수도 있는데 그걸 우리가 덧씌우면 꼬인다.
 */

export interface QueryConsoleProps {
  connId: string
  active: boolean
  autoCommit: boolean
  onTxDirty: () => void
  /**
   * 써 둔 SQL 을 담아 둘 칸의 화면 접두사(`TablePane.scope` 와 같은 규칙). 주지 않으면
   * 데이터베이스 뷰어의 기존 칸을 쓴다 — 두 화면이 같은 칸을 나눠 쓰면 두 콘솔이 동시에
   * 떠 있는 동안(탭은 keep-alive 다) 서로의 초안을 덮어쓴다.
   */
  scope?: string
  /**
   * 바깥 껍데기의 배치 클래스. 기본값 `absolute inset-0` 은 데이터베이스 뷰어의
   * keep-alive 탭 더미와의 약속이므로, 그렇게 쌓지 않는 화면만 자기 배치를 준다
   * (`TablePane` 과 같은 규칙).
   */
  className?: string
}

/** 갱신 건수만 돌아온 문장인지. */
function isUpdate(r: db.QueryResult): r is db.UpdateResult {
  return r.kind === "update"
}

export function QueryConsole({
  connId,
  active,
  autoCommit,
  onTxDirty,
  scope,
  className,
}: QueryConsoleProps) {
  const [sql, setSql] = useState(() => getConsoleSql(connId, scope))
  const [limit, setLimit] = useState(500)
  const [running, setRunning] = useState(false)
  const [response, setResponse] = useState<QueryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const tokenRef = useRef<string | null>(null)

  const run = async () => {
    const area = areaRef.current
    // 선택 영역이 있으면 그것만, 없으면 전체.
    const selection =
      area && area.selectionStart !== area.selectionEnd
        ? sql.slice(area.selectionStart, area.selectionEnd)
        : sql
    const text = selection.trim()
    if (!text) return

    const token = crypto.randomUUID()
    tokenRef.current = token
    setRunning(true)
    setError(null)
    setNotice(null)
    try {
      const res = await db.query(connId, text, limit, token)
      setResponse(res)
      // DML 을 수동 커밋 모드에서 돌렸으면 커밋해야 남는다는 걸 위쪽에 알린다.
      if (!res.autoCommit && res.results.some(isUpdate)) onTxDirty()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
      tokenRef.current = null
    }
  }

  const stop = async () => {
    const token = tokenRef.current
    if (!token) return
    try {
      const r = await db.cancel(connId, token)
      if (!r.cancelled) setNotice(r.reason ?? "취소하지 못했습니다.")
    } catch (e) {
      setNotice((e as Error).message)
    }
  }

  const tx = async (kind: "commit" | "rollback") => {
    try {
      const r =
        kind === "commit" ? await db.commit(connId) : await db.rollback(connId)
      const ok = "committed" in r ? r.committed : r.rolledBack
      setNotice(
        ok
          ? kind === "commit"
            ? "커밋했습니다."
            : "롤백했습니다."
          : (r.reason ?? "적용할 트랜잭션이 없습니다.")
      )
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div
      className={cn(
        "flex flex-col",
        className ?? "absolute inset-0",
        // display:none 이 아니라 visibility 로 감춰야 숨은 동안 스크롤 위치가 남는다.
        !active && "invisible"
      )}
      aria-hidden={!active}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
        <TerminalIcon className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="text-[15px] font-bold">쿼리 콘솔</h2>

        <div className="ml-auto flex items-center gap-1.5">
          <label
            className="text-[11px] text-muted-foreground"
            title="결과 그리드에 가져올 최대 행 수"
          >
            최대 행
          </label>
          <Input
            type="number"
            value={limit}
            onChange={(e) =>
              setLimit(
                Math.max(1, Math.min(20000, Number(e.target.value) || 1))
              )
            }
            className="h-7 w-24 text-[13px]"
          />
          {running ? (
            <Button variant="outline" size="xs" onClick={() => void stop()}>
              <SquareIcon />
              중지
            </Button>
          ) : (
            <Button size="xs" onClick={() => void run()}>
              <PlayIcon />
              실행
            </Button>
          )}
          {!autoCommit && (
            <>
              <span className="mx-1 h-4 w-px bg-border" />
              <Button
                variant="outline"
                size="xs"
                onClick={() => void tx("commit")}
              >
                <CheckIcon />
                커밋
              </Button>
              <Button
                variant="outline"
                size="xs"
                onClick={() => void tx("rollback")}
              >
                <UndoIcon />
                롤백
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="shrink-0 border-b border-border p-3">
        <textarea
          ref={areaRef}
          value={sql}
          onChange={(e) => {
            setSql(e.target.value)
            setConsoleSql(connId, e.target.value, scope)
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault()
              void run()
            }
          }}
          spellCheck={false}
          placeholder="SELECT * FROM …&#10;&#10;⌘/Ctrl + Enter 로 실행합니다. 일부만 선택하면 선택한 부분만 실행됩니다."
          className="h-40 w-full resize-y rounded-lg border border-border bg-background p-2.5 font-mono text-[13px] outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid"
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          {autoCommit
            ? "자동 커밋 모드 — INSERT·UPDATE·DELETE 가 즉시 확정됩니다."
            : "수동 커밋 모드 — 변경은 커밋을 눌러야 확정됩니다."}
        </p>
      </div>

      {(error || notice) && (
        <div className="shrink-0 px-4 py-1.5">
          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-ui-error/10 px-2.5 py-1.5 text-[12px] whitespace-pre-wrap text-ui-error">
              <span className="flex-1">{error}</span>
              <button onClick={() => setError(null)} title="닫기">
                <XIcon className="size-3.5" />
              </button>
            </div>
          )}
          {notice && (
            <div className="flex items-start gap-2 rounded-lg bg-ui-info/10 px-2.5 py-1.5 text-[12px] text-ui-info">
              <span className="flex-1">{notice}</span>
              <button onClick={() => setNotice(null)} title="닫기">
                <XIcon className="size-3.5" />
              </button>
            </div>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {!response ? (
          <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
            {running ? "실행 중…" : "SQL 을 입력하고 실행하세요."}
          </div>
        ) : (
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center gap-3 px-4 py-1.5 text-[11px] text-muted-foreground">
              <span>{response.elapsedMs.toLocaleString()}ms</span>
              <span>결과 {response.results.length}개</span>
              {response.warnings.map((w, i) => (
                <span key={i} className="text-ui-warning">
                  {w}
                </span>
              ))}
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 pb-4">
              {response.results.length === 0 && (
                <p className="text-[13px] text-muted-foreground">
                  돌려준 결과가 없습니다.
                </p>
              )}
              {response.results.map((r, i) =>
                isUpdate(r) ? (
                  <div
                    key={i}
                    className="rounded-lg bg-ui-success/10 px-3 py-2 text-[13px] text-ui-success"
                  >
                    {r.updateCount.toLocaleString()}개 행이 변경됐습니다.
                  </div>
                ) : (
                  <div
                    key={i}
                    className="overflow-hidden rounded-[10px] border border-border"
                  >
                    <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-1.5 text-[11px] text-muted-foreground">
                      <span>{r.rows.length.toLocaleString()}행</span>
                      {r.truncated && (
                        <span className="text-ui-warning">
                          최대 행({limit.toLocaleString()})에서 잘렸습니다
                        </span>
                      )}
                    </div>
                    <div className="max-h-[60vh]">
                      <DataGrid
                        columns={r.columns}
                        rows={
                          r.rows.map((cells, ri) => ({
                            id: `r${ri}`,
                            cells,
                            state: "normal",
                          })) satisfies GridRow[]
                        }
                      />
                    </div>
                  </div>
                )
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
