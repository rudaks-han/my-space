import { useCallback, useEffect, useRef, useState } from "react"
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DatabaseIcon,
  EyeIcon,
  PlusIcon,
  RotateCwIcon,
  SearchIcon,
  TableIcon,
  TerminalIcon,
  UndoIcon,
  XIcon,
} from "lucide-react"

import { ResizeHandle } from "@/components/resize-handle"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useLocalStorage } from "@/lib/use-local-storage"
import { useResizableWidth } from "@/lib/use-resizable-width"
import { cn } from "@/lib/utils"
import { connectDb, isSystemTable, type DbConnection } from "./connection"
import { ConnectionForm } from "./connection-form"
import { useDbConnections } from "./db-connections-store"
import * as db from "./db-client"
import type { BridgeInfo, ConnInfo, SchemaRef, TableRef } from "./db-client"
import { announceDisconnect, onDisconnected } from "./disconnect-bus"
import { engineById, newConnection } from "./engines"
import { QueryConsole } from "./query-console"
import {
  getShowSystem,
  getTableFilter,
  purgeTableQuery,
  setShowSystem,
  setTableFilter,
} from "./persisted"
import { TablePane } from "./table-pane"

/**
 * 데이터베이스 뷰어 — IntelliJ 의 Database 툴윈도가 하는 일 중 매일 쓰는 부분.
 * 테이블 구조 보기 · 데이터 조회와 편집 · 쿼리 콘솔.
 *
 * 왼쪽: 접속 정보 + 스키마 + 테이블 목록. 오른쪽: 탭(keep-alive)으로 열린 테이블과 콘솔.
 * 실제 DB 통신은 Rust(`db.rs`)가 띄운 JDBC 사이드카가 한다 — 다섯 엔진(MySQL·MariaDB·
 * PostgreSQL·Oracle·H2·SQLite)을 한 경로로 처리하려면 JDBC 말고는 선택지가 없다.
 *
 * **한 번에 한 접속만 연결한다.** 저장은 여러 개 해 두고 골라 쓰는 방식이다. 동시에
 * 여러 DB 를 붙이면 탭마다 어느 접속 것인지를 들고 다녀야 하는데, 그 복잡도에 비해
 * 얻는 게 적다(전환은 클릭 한 번이다).
 */

const CONSOLE_TAB = "c:console"

/** 탭 id — 같은 이름의 테이블이 스키마마다 있을 수 있어 카탈로그·스키마까지 넣는다. */
function tabIdOf(t: TableRef) {
  return `t:${t.catalog ?? ""}${t.schema ?? ""}${t.name}`
}

/** 스키마 선택 값(카탈로그·스키마 쌍을 하나의 문자열로). */
function schemaKeyOf(s: SchemaRef) {
  return `${s.catalog ?? ""}${s.schema ?? ""}`
}

const ASIDE_WIDTH_KEY = "myspace.dbAsideWidth"
const DEFAULT_ASIDE_WIDTH = 320
const MIN_ASIDE_WIDTH = 260
const MAX_ASIDE_WIDTH = 640

const selectClass =
  "h-8 w-full rounded-lg border border-input bg-background px-2 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-ring"

export function DbViewerView() {
  // 접속 목록은 컨텍스트 하나가 들고 있다 — 같은 창의 다른 화면(IntelliJ Cowork)도 같은
  // 목록을 보므로 여기서 `useLocalStorage` 로 다시 읽으면 서로의 변경을 덮어쓴다.
  // 반면 **어느 접속을 골랐는지는 화면마다 다른 값**이라 여기 남겨 둔다.
  const { connections, setConnections } = useDbConnections()
  const [activeConnId, setActiveConnId] = useLocalStorage<string | null>(
    "myspace.dbActiveConn",
    null
  )

  const [info, setInfo] = useState<ConnInfo | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [connError, setConnError] = useState<string | null>(null)
  const [bridge, setBridge] = useState<BridgeInfo | null>(null)
  const [formOpen, setFormOpen] = useState(true)

  const [schemas, setSchemas] = useState<SchemaRef[]>([])
  const [schemaKey, setSchemaKey] = useState<string>("")
  const [tables, setTables] = useState<TableRef[]>([])
  const [loadingTables, setLoadingTables] = useState(false)
  const [filter, setFilter] = useState(() => getTableFilter())
  const [showSystem, setShowSystemState] = useState(() => getShowSystem())

  const [openTabs, setOpenTabs] = useState<string[]>([])
  const [tabTables, setTabTables] = useState<Record<string, TableRef>>({})
  const [activeTab, setActiveTab] = useState<string | null>(null)

  const [autoCommit, setAutoCommitState] = useState(true)
  const [txDirty, setTxDirty] = useState(false)
  const [txNotice, setTxNotice] = useState<string | null>(null)

  const autoTried = useRef(false)

  const {
    width: asideWidth,
    resizing,
    startResize,
  } = useResizableWidth(
    ASIDE_WIDTH_KEY,
    DEFAULT_ASIDE_WIDTH,
    MIN_ASIDE_WIDTH,
    MAX_ASIDE_WIDTH
  )

  const active = connections.find((c) => c.id === activeConnId) ?? null

  /* ─────────────── 브리지 상태 ─────────────── */

  useEffect(() => {
    void db
      .bridgeInfo()
      .then(setBridge)
      .catch(() => setBridge(null))
  }, [])

  /* ─────────────── 접속 목록 ─────────────── */

  const patchActive = useCallback(
    (patch: Partial<DbConnection>) => {
      if (!activeConnId) return
      setConnections((prev) =>
        prev.map((c) => (c.id === activeConnId ? { ...c, ...patch } : c))
      )
    },
    [activeConnId, setConnections]
  )

  const addConnection = () => {
    const c = newConnection()
    setConnections((prev) => [...prev, c])
    setActiveConnId(c.id)
    setFormOpen(true)
  }

  const deleteConnection = () => {
    if (!active) return
    const id = active.id
    void db.forgetPassword(id).catch(() => {
      // 저장된 비밀번호가 없으면 그냥 넘어간다.
    })
    if (info) void handleDisconnect()
    setConnections((prev) => prev.filter((c) => c.id !== id))
    setActiveConnId((prev) =>
      prev === id ? (connections.find((c) => c.id !== id)?.id ?? null) : prev
    )
  }

  /* ─────────────── 연결 ─────────────── */

  const loadTables = useCallback(
    async (connId: string, s: SchemaRef | null) => {
      setLoadingTables(true)
      try {
        const r = await db.tables(connId, s?.catalog ?? null, s?.schema ?? null)
        setTables(r.tables)
      } catch (e) {
        setConnError((e as Error).message)
      } finally {
        setLoadingTables(false)
      }
    },
    []
  )

  const handleConnect = useCallback(
    async (conn: DbConnection, password: string) => {
      setConnecting(true)
      setConnError(null)
      try {
        const ci = await connectDb(conn, password)
        setInfo(ci)
        setAutoCommitState(ci.autoCommit)
        setTxDirty(false)
        setFormOpen(false)

        const sr = await db.schemas(conn.id)
        setSchemas(sr.schemas)
        // 접속이 알려 준 현재 스키마를 고르고, 없으면 첫 번째.
        const current = sr.schemas.find(
          (s) =>
            (s.schema ?? null) === (sr.current.schema ?? null) &&
            (s.catalog ?? null) === (sr.current.catalog ?? null)
        )
        const pick = current ?? sr.schemas[0] ?? null
        setSchemaKey(pick ? schemaKeyOf(pick) : "")
        await loadTables(conn.id, pick)
      } catch (e) {
        setInfo(null)
        setSchemas([])
        setTables([])
        setConnError((e as Error).message)
      } finally {
        setConnecting(false)
      }
    },
    [loadTables]
  )

  /** 이 접속이 닫혔다는 사실을 화면 상태에 반영한다(내가 닫았든, 다른 화면이 닫았든). */
  const forgetConnection = useCallback(() => {
    setInfo(null)
    setSchemas([])
    setTables([])
    setOpenTabs([])
    setTabTables({})
    setActiveTab(null)
    setTxDirty(false)
    setFormOpen(true)
  }, [])

  const handleDisconnect = useCallback(async () => {
    if (!activeConnId) return
    try {
      await db.disconnect(activeConnId)
    } catch {
      // 이미 끊긴 접속이면 그대로 정리만 한다.
    }
    forgetConnection()
    // 같은 `connId` 를 보고 있는 다른 화면(IntelliJ Cowork)에도 알린다 — `db_disconnect` 는
    // 브리지의 접속을 모든 화면에서 닫으므로, 알리지 않으면 저쪽은 "연결됨"인 채로
    // 이미 롤백된 편집에 커밋을 권하고 다음 질의부터 전부 실패한다.
    announceDisconnect(activeConnId)
  }, [activeConnId, forgetConnection])

  /*
   * 반대 방향 — 다른 화면이 이 접속을 닫은 경우. 접속이 살아 있다고 믿는 쪽이 남으면
   * 안 되므로, 지금 붙어 있는 접속의 id 가 오면 같은 정리를 한다.
   */
  useEffect(
    () =>
      onDisconnected((id) => {
        if (id === activeConnId && info) forgetConnection()
      }),
    [activeConnId, info, forgetConnection]
  )

  // 자동 연결(앱 실행 후 한 번만).
  useEffect(() => {
    if (autoTried.current) return
    autoTried.current = true
    const c = connections.find((x) => x.id === activeConnId)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (c?.autoConnect) void handleConnect(c, "")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ─────────────── 스키마 · 테이블 ─────────────── */

  const currentSchema =
    schemas.find((s) => schemaKeyOf(s) === schemaKey) ?? schemas[0] ?? null

  const openTable = (t: TableRef) => {
    const id = tabIdOf(t)
    setTabTables((prev) => ({ ...prev, [id]: t }))
    setOpenTabs((prev) => (prev.includes(id) ? prev : [...prev, id]))
    setActiveTab(id)
  }

  const openConsole = () => {
    setOpenTabs((prev) =>
      prev.includes(CONSOLE_TAB) ? prev : [CONSOLE_TAB, ...prev]
    )
    setActiveTab(CONSOLE_TAB)
  }

  const closeTab = (id: string) => {
    setOpenTabs((prev) => {
      const pos = prev.indexOf(id)
      const next = prev.filter((t) => t !== id)
      setActiveTab((cur) =>
        cur === id ? (next[Math.min(pos, next.length - 1)] ?? null) : cur
      )
      return next
    })
    const t = tabTables[id]
    if (t && activeConnId) {
      purgeTableQuery(`${activeConnId}:${t.catalog}.${t.schema}.${t.name}`)
    }
  }

  /* ─────────────── 트랜잭션 ─────────────── */

  const toggleAutoCommit = async (on: boolean) => {
    if (!activeConnId) return
    try {
      const r = await db.setAutoCommit(activeConnId, on)
      setAutoCommitState(r.autoCommit)
      // 자동 커밋을 켜면 JDBC 규약상 열린 트랜잭션이 커밋된다.
      if (on) setTxDirty(false)
    } catch (e) {
      setConnError((e as Error).message)
    }
  }

  const runTx = async (kind: "commit" | "rollback") => {
    if (!activeConnId) return
    try {
      const r =
        kind === "commit"
          ? await db.commit(activeConnId)
          : await db.rollback(activeConnId)
      const ok = "committed" in r ? r.committed : r.rolledBack
      setTxNotice(
        ok
          ? kind === "commit"
            ? "커밋했습니다."
            : "롤백했습니다."
          : (r.reason ?? "적용할 트랜잭션이 없습니다.")
      )
      if (ok) setTxDirty(false)
    } catch (e) {
      setConnError((e as Error).message)
    }
  }

  /* ─────────────── 렌더 ─────────────── */

  const needle = filter.trim().toLowerCase()
  const visibleTables = tables.filter(
    (t) =>
      (showSystem || !isSystemTable(t)) &&
      (!needle || t.name.toLowerCase().includes(needle))
  )

  const tabLabel = (id: string) =>
    id === CONSOLE_TAB ? "쿼리 콘솔" : (tabTables[id]?.name ?? id)

  return (
    <div className="flex h-full gap-3">
      {/* ── 왼쪽: 접속 + 스키마 + 테이블 (폭 조절 가능) ── */}
      {/*
        `overflow-hidden` 을 걸지 않는다 — `ResizeHandle` 은 패널과 본문 사이 간격에
        놓이도록 `-right-2` 로 패널 **밖에** 떠 있어서, 그걸 걸면 손잡이가 통째로
        잘려 보이지도 잡히지도 않는다(ES 뷰어의 aside 도 같은 이유로 걸지 않는다).
        안쪽 카드들이 각자 `min-h-0` + `overflow-y-auto` 로 넘침을 처리하고 목록은
        `truncate` 라 패널이 넓어지지도 않는다.
      */}
      <aside
        className="relative flex shrink-0 flex-col gap-3"
        style={{ width: asideWidth }}
      >
        {/* 접속 */}
        <div className="shrink-0 overflow-y-auto rounded-[10px] border border-border bg-card p-3 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <div className="mb-2 flex items-center gap-2">
            <DatabaseIcon className="size-4" />
            <span className="text-[15px] font-bold">접속</span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="ml-auto"
              title="새 접속 만들기"
              onClick={addConnection}
            >
              <PlusIcon />
            </Button>
          </div>

          {connections.length === 0 ? (
            <p className="py-2 text-[13px] text-muted-foreground">
              저장된 접속이 없습니다. <b>+</b> 를 눌러 만드세요.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <select
                value={activeConnId ?? ""}
                onChange={(e) => {
                  if (info) void handleDisconnect()
                  setActiveConnId(e.target.value)
                  setFormOpen(true)
                }}
                className={selectClass}
              >
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {engineById(c.engine).label}
                  </option>
                ))}
              </select>

              {/* 연결됐으면 폼을 접어 둔다 — 목록에 자리를 내준다. */}
              <button
                onClick={() => setFormOpen((v) => !v)}
                className="flex items-center gap-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground"
              >
                {formOpen ? (
                  <ChevronDownIcon className="size-3" />
                ) : (
                  <ChevronRightIcon className="size-3" />
                )}
                접속 정보
              </button>

              {formOpen && active && (
                <ConnectionForm
                  key={active.id}
                  conn={active}
                  onChange={patchActive}
                  onDelete={deleteConnection}
                  onConnect={(pw) => void handleConnect(active, pw)}
                  onDisconnect={() => void handleDisconnect()}
                  connecting={connecting}
                  info={info}
                  error={connError}
                />
              )}

              {!formOpen && info && (
                <div className="rounded-lg bg-ui-success/10 px-2.5 py-1.5 text-[12px] text-ui-success">
                  ✓ {info.product} {info.productVersion.split(" ")[0]}
                </div>
              )}
            </div>
          )}

          {bridge && !bridge.ok && (
            <div className="mt-2 rounded-lg bg-ui-error/10 px-2.5 py-1.5 text-[11px] whitespace-pre-wrap text-ui-error">
              {bridge.error}
            </div>
          )}
        </div>

        {/* 스키마 + 테이블 */}
        <div className="flex min-h-0 flex-1 flex-col rounded-[10px] border border-border bg-card p-3 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[15px] font-bold">테이블</span>
            <Button
              variant="ghost"
              size="icon-xs"
              title="목록 새로고침"
              disabled={!info || loadingTables}
              onClick={() =>
                activeConnId && void loadTables(activeConnId, currentSchema)
              }
            >
              <RotateCwIcon className={cn(loadingTables && "animate-spin")} />
            </Button>
          </div>

          {info && schemas.length > 0 && (
            <select
              value={schemaKey}
              onChange={(e) => {
                setSchemaKey(e.target.value)
                const s =
                  schemas.find((x) => schemaKeyOf(x) === e.target.value) ?? null
                if (activeConnId) void loadTables(activeConnId, s)
              }}
              className={cn(selectClass, "mb-2")}
              title="스키마"
            >
              {schemas.map((s) => (
                <option key={schemaKeyOf(s)} value={schemaKeyOf(s)}>
                  {s.label}
                </option>
              ))}
            </select>
          )}

          <div className="relative mb-2">
            <SearchIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              placeholder="테이블 검색…"
              disabled={!info}
              onChange={(e) => {
                setFilter(e.target.value)
                setTableFilter(e.target.value)
              }}
              className="pl-8"
            />
          </div>

          <label className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={showSystem}
              onChange={(e) => {
                setShowSystemState(e.target.checked)
                setShowSystem(e.target.checked)
              }}
            />
            시스템 테이블 표시
          </label>

          <div className="min-h-0 flex-1 overflow-auto">
            {!info ? (
              <p className="px-1 py-2 text-[13px] text-muted-foreground">
                연결하면 테이블이 표시됩니다.
              </p>
            ) : visibleTables.length === 0 ? (
              <p className="px-1 py-2 text-[13px] text-muted-foreground">
                {loadingTables ? "읽는 중…" : "표시할 테이블이 없습니다."}
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {visibleTables.map((t) => {
                  const id = tabIdOf(t)
                  const isView = /VIEW/i.test(t.type)
                  const Icon = isView ? EyeIcon : TableIcon
                  return (
                    <li key={id}>
                      <button
                        onClick={() => openTable(t)}
                        title={`${t.name} · ${t.type}`}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors",
                          id === activeTab
                            ? "bg-ui-selection font-bold text-ui-selection-fg"
                            : "hover:bg-ui-list-hover"
                        )}
                      >
                        <Icon
                          className={cn(
                            "size-3.5 shrink-0",
                            id === activeTab
                              ? "text-ui-selection-fg/80"
                              : "text-muted-foreground"
                          )}
                        />
                        <span className="flex-1 truncate">{t.name}</span>
                        {isView && (
                          <span
                            className={cn(
                              "shrink-0 text-[10px]",
                              id === activeTab
                                ? "text-ui-selection-fg/80"
                                : "text-muted-foreground"
                            )}
                          >
                            뷰
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {info && (
            <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2">
              <Button variant="outline" size="xs" onClick={openConsole}>
                <TerminalIcon />
                쿼리 콘솔 열기
              </Button>
              <label
                className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
                title="끄면 변경이 커밋을 누를 때까지 트랜잭션에 남습니다."
              >
                <input
                  type="checkbox"
                  checked={autoCommit}
                  onChange={(e) => void toggleAutoCommit(e.target.checked)}
                />
                자동 커밋
              </label>
            </div>
          )}
        </div>

        <ResizeHandle
          resizing={resizing}
          onPointerDown={startResize}
          label="테이블 목록 폭 조절"
        />
      </aside>

      {/* ── 오른쪽: 탭 + 내용 ── */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        {/* 수동 커밋 모드에서 커밋되지 않은 변경이 있으면 어디서든 보이게 */}
        {!autoCommit && (txDirty || txNotice) && (
          <div className="flex shrink-0 items-center gap-2 border-b border-border bg-ui-warning/10 px-4 py-1.5 text-[12px]">
            <span className="flex-1">
              {txDirty
                ? "커밋되지 않은 변경이 트랜잭션에 남아 있습니다."
                : txNotice}
            </span>
            {txDirty && (
              <>
                <Button size="xs" onClick={() => void runTx("commit")}>
                  <CheckIcon />
                  커밋
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => void runTx("rollback")}
                >
                  <UndoIcon />
                  롤백
                </Button>
              </>
            )}
            <button
              onClick={() => setTxNotice(null)}
              title="닫기"
              className={cn(txDirty && "hidden")}
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        )}

        {openTabs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="flex size-12 items-center justify-center rounded-[10px] bg-muted">
              <DatabaseIcon className="size-6" />
            </span>
            <p className="text-[15px] font-bold">
              {info ? "테이블을 선택하세요" : "데이터베이스에 연결하세요"}
            </p>
            <p className="text-[13px] text-muted-foreground">
              {info
                ? "왼쪽 목록에서 테이블을 선택하면 탭으로 열립니다."
                : "왼쪽에서 접속 정보를 입력하고 연결하세요."}
            </p>
          </div>
        ) : (
          <>
            <div className="flex shrink-0 items-stretch overflow-x-auto border-b border-border">
              {openTabs.map((id) => (
                <div
                  key={id}
                  onClick={() => setActiveTab(id)}
                  title={tabLabel(id)}
                  className={cn(
                    "group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-3 py-1.5 text-[13px]",
                    id === activeTab
                      ? "bg-card font-bold"
                      : "bg-muted/30 text-muted-foreground hover:bg-ui-list-hover"
                  )}
                >
                  {id === CONSOLE_TAB ? (
                    <TerminalIcon className="size-3.5" />
                  ) : (
                    <TableIcon className="size-3.5" />
                  )}
                  <span className="max-w-40 truncate">{tabLabel(id)}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTab(id)
                    }}
                    className="flex size-4 items-center justify-center rounded opacity-50 hover:bg-ui-list-hover hover:opacity-100"
                    title="탭 닫기"
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              ))}
            </div>

            {/* keep-alive 패널 — 활성 탭만 보이고 나머지는 invisible 로 남는다. */}
            <div className="relative min-h-0 flex-1">
              {activeConnId &&
                info &&
                openTabs.map((id) =>
                  id === CONSOLE_TAB ? (
                    <QueryConsole
                      key={id}
                      connId={activeConnId}
                      active={id === activeTab}
                      autoCommit={autoCommit}
                      onTxDirty={() => setTxDirty(true)}
                    />
                  ) : tabTables[id] ? (
                    <TablePane
                      key={id}
                      connId={activeConnId}
                      table={tabTables[id]}
                      active={id === activeTab}
                      autoCommit={autoCommit}
                      onTxDirty={() => setTxDirty(true)}
                    />
                  ) : null
                )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
