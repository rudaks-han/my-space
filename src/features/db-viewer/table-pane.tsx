import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CheckIcon,
  DatabaseIcon,
  KeyIcon,
  ListTreeIcon,
  PlusIcon,
  RotateCwIcon,
  SigmaIcon,
  Trash2Icon,
  UndoIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { DataGrid, type GridRow } from "./data-grid"
import * as db from "./db-client"
import type { Cell, RowsResult, TableMeta, TableRef } from "./db-client"
import { getTableQuery, setTableQuery, type TableQuery } from "./persisted"

/**
 * 테이블 탭 하나 — 데이터 조회·편집과 구조(컬럼/인덱스/외래키) 보기.
 *
 * ── 편집 모델 ──
 * 셀을 고쳐도 바로 DB 로 나가지 않는다. 변경은 이 컴포넌트가 세 덩어리로 모아 둔다:
 * `pending`(수정) · `newRows`(추가) · `deleted`(삭제). 커밋을 눌러야 그 셋이 한 번에
 * 나간다. IntelliJ 의 그리드와 같은 방식이고, 이유도 같다 — 편집 도중 트랜잭션을
 * 열어 두면 사용자가 화면을 보며 고민하는 내내 DB 락을 잡고 있게 된다.
 *
 * 원자성은 브리지 쪽에서 챙긴다: 자동 커밋 모드에서도 배치 전체를 하나의 트랜잭션으로
 * 실행하고, UPDATE·DELETE 가 정확히 1행을 건드리지 않으면 전부 롤백한다.
 *
 * ── 편집 가능 조건 ──
 * 기본키가 있어야 한다. 없으면 어떤 행을 고칠지 WHERE 로 특정할 수 없어 읽기 전용이
 * 된다(뷰도 마찬가지). 이건 조용히 실패하면 안 되는 종류라 툴바에 사유를 띄운다.
 */

type SubTab = "data" | "columns" | "keys"

export interface TablePaneProps {
  connId: string
  table: TableRef
  active: boolean
  /** 접속의 자동 커밋 상태(모든 탭이 같은 값을 본다). */
  autoCommit: boolean
  /** 수동 커밋 모드에서 커밋되지 않은 변경이 남아 있는지 알린다. */
  onTxDirty: () => void
  /**
   * 조회 조건(`persisted.ts`)을 담아 둘 칸의 화면 접두사. 주지 않으면 데이터베이스
   * 뷰어의 기존 칸을 쓴다 — 두 화면이 접두사 없이 같은 칸을 나눠 쓰면, 한쪽에서 탭을
   * 닫을 때 도는 `purgeTableQuery` 가 다른 쪽이 쓰고 있는 WHERE 절을 지운다.
   */
  scope?: string
  /**
   * 바깥 껍데기의 배치 클래스. 기본값 `absolute inset-0` 은 데이터베이스 뷰어의
   * keep-alive 탭 더미(겹쳐 놓고 활성 탭만 보이기)와의 약속이라, 그렇게 쌓지 않는
   * 화면(고정 자리에 하나만 놓는 경우)은 여기에 자기 배치를 준다.
   */
  className?: string
}

/** 새로 추가한 행. 사용자가 실제로 값을 넣은 컬럼만 `values` 에 들어간다. */
interface NewRow {
  id: string
  values: Record<string, Cell>
}

export function TablePane({
  connId,
  table,
  active,
  autoCommit,
  onTxDirty,
  scope,
  className,
}: TablePaneProps) {
  const storeKey = `${scope ? `${scope}:` : ""}${connId}:${table.catalog}.${table.schema}.${table.name}`

  const [sub, setSub] = useState<SubTab>("data")
  const [meta, setMeta] = useState<TableMeta | null>(null)
  const [result, setResult] = useState<RowsResult | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [offset, setOffset] = useState(0)
  const [q, setQ] = useState<TableQuery>(() => getTableQuery(storeKey))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [pending, setPending] = useState<Record<string, Record<string, Cell>>>(
    {}
  )
  const [newRows, setNewRows] = useState<NewRow[]>([])
  const [deleted, setDeleted] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const loadedOnce = useRef(false)
  const firstLoadBusy = useRef(false)
  const newRowSeq = useRef(0)

  const isView = /VIEW/i.test(table.type)
  // 매 렌더마다 새 배열이 되면 아래 useMemo 들의 의존성이 계속 바뀐다.
  const pk = useMemo(() => meta?.primaryKey ?? [], [meta])
  const readOnlyReason = !meta
    ? null
    : isView
      ? "뷰는 편집할 수 없습니다."
      : pk.length === 0
        ? "기본키가 없어 행을 특정할 수 없습니다. 읽기 전용입니다."
        : null
  const editable = readOnlyReason === null && meta !== null

  const dirtyCount = Object.keys(pending).length + newRows.length + deleted.size

  /* ─────────────── 조회 ─────────────── */

  const load = useCallback(
    async (nextOffset: number, query: TableQuery) => {
      setLoading(true)
      setError(null)
      try {
        const rows = await db.tableRows({
          connId,
          catalog: table.catalog,
          schema: table.schema,
          table: table.name,
          limit: query.limit,
          offset: nextOffset,
          orderBy: query.orderBy.trim() || null,
          whereClause: query.where.trim() || null,
          token: null,
        })
        setResult(rows)
        setOffset(nextOffset)
        // 새로 읽었으면 화면과 어긋난 보류분은 의미가 없다.
        setPending({})
        setNewRows([])
        setDeleted(new Set())
        setSelected(new Set())
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    },
    [connId, table.catalog, table.schema, table.name]
  )

  /** 성공했는지 알려 준다 — "한 번 읽었다"는 표시를 성공했을 때만 세워야 한다. */
  const loadMeta = useCallback(async () => {
    try {
      setMeta(
        await db.tableMeta(connId, table.catalog, table.schema, table.name)
      )
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    }
  }, [connId, table.catalog, table.schema, table.name])

  /**
   * 조회 — 구조를 아직 못 읽었으면 같이 읽는다.
   *
   * `meta` 가 없으면 기본키를 몰라 격자가 **읽기 전용인데 그 사유조차 비어 있다**
   * (`readOnlyReason` 이 `!meta` 일 때 null 이다). 연결 전에 복원된 탭이 딱 그 상태로
   * 남으므로, 새로고침·조회는 데이터만이 아니라 구조도 다시 시도해야 한다.
   */
  const reload = useCallback(
    async (nextOffset: number, query: TableQuery) => {
      if (!meta) await loadMeta()
      await load(nextOffset, query)
    },
    [meta, loadMeta, load]
  )

  // 탭이 처음 활성화될 때 한 번만 읽는다(keep-alive — 돌아왔을 때 이전 데이터가 보여야 한다).
  // **성공했을 때만 "읽었다"로 친다.** 앱을 다시 켜면 아무 데도 연결되지 않은 채 탭이
  // 복원되는데, 시도 전에 표시를 세우면 그 뒤로 구조를 영영 다시 읽지 않아 연결한 뒤에도
  // 격자가 이유 없이 읽기 전용으로 남는다.
  useEffect(() => {
    if (!active || loadedOnce.current || firstLoadBusy.current) return
    firstLoadBusy.current = true
    void (async () => {
      try {
        const ok = await loadMeta()
        await load(0, q)
        if (ok) loadedOnce.current = true
      } finally {
        firstLoadBusy.current = false
      }
    })()
    // q 는 최초 스냅샷만 필요하다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, load, loadMeta])

  const patchQuery = (p: Partial<TableQuery>) => {
    const next = { ...q, ...p }
    setQ(next)
    setTableQuery(storeKey, next)
  }

  const loadCount = async () => {
    try {
      const r = await db.count(
        connId,
        table.catalog,
        table.schema,
        table.name,
        q.where.trim() || null
      )
      setTotal(r.count)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /* ─────────────── 행 키 ─────────────── */

  /** 결과 컬럼에서 기본키 컬럼의 위치. 드라이버가 대소문자를 바꿔 주는 경우가 있어 무시 비교. */
  const pkIndexes = useMemo(() => {
    if (!result || pk.length === 0) return null
    const idx = pk.map((name) =>
      result.columns.findIndex(
        (c) => c.name.toLowerCase() === name.toLowerCase()
      )
    )
    return idx.every((i) => i >= 0) ? idx : null
  }, [result, pk])

  const rowKeyOf = useCallback(
    (row: Cell[]) =>
      pkIndexes ? JSON.stringify(pkIndexes.map((i) => row[i])) : null,
    [pkIndexes]
  )

  /** 행 키 → 기본키 컬럼값. 커밋할 때 WHERE 절에 들어간다. */
  const keyValuesOf = useCallback(
    (row: Cell[]): Record<string, Cell> => {
      const out: Record<string, Cell> = {}
      if (!pkIndexes || !result) return out
      // 컬럼 이름은 결과셋 쪽 표기를 쓴다 — 메타데이터와 대소문자가 다른 드라이버가 있다.
      for (const i of pkIndexes) {
        out[result.columns[i].name] = row[i]
      }
      return out
    },
    [pkIndexes, result]
  )

  /* ─────────────── 편집 ─────────────── */

  const onCellCommit = (rowId: string, colIndex: number, value: Cell) => {
    if (!result) return
    const colName = result.columns[colIndex].name

    if (rowId.startsWith("new:")) {
      setNewRows((prev) =>
        prev.map((r) =>
          r.id === rowId
            ? { ...r, values: { ...r.values, [colName]: value } }
            : r
        )
      )
      return
    }

    const original = result.rows.find((r) => rowKeyOf(r) === rowId)
    if (!original) return
    const originalValue = original[colIndex] ?? null

    setPending((prev) => {
      const patch = { ...(prev[rowId] ?? {}) }
      if (value === originalValue) {
        // 원래 값으로 되돌렸으면 보류에서 빼야 한다 — 안 그러면 아무것도 안 바뀐 UPDATE 가 나간다.
        delete patch[colName]
      } else {
        patch[colName] = value
      }
      const next = { ...prev }
      if (Object.keys(patch).length === 0) delete next[rowId]
      else next[rowId] = patch
      return next
    })
  }

  const addRow = () => {
    newRowSeq.current += 1
    setNewRows((prev) => [
      ...prev,
      { id: `new:${newRowSeq.current}`, values: {} },
    ])
    setSub("data")
  }

  const deleteSelected = () => {
    if (selected.size === 0) return
    const stillNew = newRows.filter((r) => !selected.has(r.id))
    const removedKeys = [...selected].filter((id) => !id.startsWith("new:"))
    setNewRows(stillNew)
    setDeleted((prev) => {
      const next = new Set(prev)
      for (const k of removedKeys) next.add(k)
      return next
    })
    setSelected(new Set())
  }

  const revert = () => {
    setPending({})
    setNewRows([])
    setDeleted(new Set())
    setSelected(new Set())
    setNotice(null)
  }

  const commit = async () => {
    if (!result || dirtyCount === 0) return
    const changes: db.Change[] = []
    const base = {
      catalog: table.catalog,
      schema: table.schema,
      table: table.name,
    }

    // 삭제 → 수정 → 추가 순. 지운 자리에 같은 키로 다시 넣는 흐름이 유니크 제약에 걸리지 않는다.
    for (const row of result.rows) {
      const key = rowKeyOf(row)
      if (key && deleted.has(key)) {
        changes.push({ op: "delete", ...base, keys: keyValuesOf(row) })
      }
    }
    for (const row of result.rows) {
      const key = rowKeyOf(row)
      if (!key || deleted.has(key)) continue
      const patch = pending[key]
      if (patch && Object.keys(patch).length > 0) {
        changes.push({
          op: "update",
          ...base,
          keys: keyValuesOf(row),
          values: patch,
        })
      }
    }
    for (const r of newRows) {
      if (Object.keys(r.values).length === 0) continue
      changes.push({ op: "insert", ...base, values: r.values })
    }

    if (changes.length === 0) {
      revert()
      return
    }

    setLoading(true)
    setError(null)
    try {
      const res = await db.applyChanges(connId, changes)
      setNotice(
        res.pendingTx
          ? `${res.applied}건 반영 — 아직 커밋되지 않았습니다. 툴바의 커밋을 누르세요.`
          : `${res.applied}건 반영·커밋 완료`
      )
      if (res.pendingTx) onTxDirty()
      await load(offset, q)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  /* ─────────────── 그리드 행 조립 ─────────────── */

  const gridRows: GridRow[] = useMemo(() => {
    if (!result) return []
    const out: GridRow[] = []
    result.rows.forEach((row, i) => {
      const key = rowKeyOf(row) ?? `row:${i}`
      const patch = pending[key]
      const changed = new Set<number>()
      const cells = row.map((v, ci) => {
        const name = result.columns[ci].name
        if (patch && name in patch) {
          changed.add(ci)
          return patch[name]
        }
        return v
      })
      out.push({
        id: key,
        cells,
        state: deleted.has(key)
          ? "deleted"
          : changed.size > 0
            ? "modified"
            : "normal",
        changed,
      })
    })
    for (const nr of newRows) {
      out.push({
        id: nr.id,
        cells: result.columns.map((c) =>
          c.name in nr.values ? nr.values[c.name] : null
        ),
        state: "new",
        changed: new Set(
          result.columns
            .map((c, i) => (c.name in nr.values ? i : -1))
            .filter((i) => i >= 0)
        ),
      })
    }
    return out
  }, [result, pending, newRows, deleted, rowKeyOf])

  const pageSize = q.limit
  const rowsOnPage = result?.rows.length ?? 0

  /* ─────────────── 렌더 ─────────────── */

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
      {/* 헤더 + 서브탭 */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <DatabaseIcon className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="truncate text-[15px] font-bold" title={table.name}>
          {table.name}
        </h2>
        <span className="shrink-0 rounded-full bg-muted px-2 text-[11px] font-bold text-muted-foreground">
          {isView ? "뷰" : "테이블"}
        </span>
        {table.remarks && (
          <span className="truncate text-[13px] text-muted-foreground">
            {table.remarks}
          </span>
        )}
        <div className="ml-auto flex shrink-0 gap-1">
          {(
            [
              ["data", "데이터", DatabaseIcon],
              ["columns", "컬럼", ListTreeIcon],
              ["keys", "인덱스·키", KeyIcon],
            ] as const
          ).map(([id, label, Icon]) => (
            <Button
              key={id}
              variant={sub === id ? "default" : "ghost"}
              size="xs"
              onClick={() => setSub(id)}
            >
              <Icon />
              {label}
            </Button>
          ))}
        </div>
      </div>

      {sub === "data" && (
        <>
          {/* 툴바 1 — 조회 조건 */}
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
            <Button
              variant="ghost"
              size="icon-xs"
              title="새로고침"
              disabled={loading}
              onClick={() => void reload(offset, q)}
            >
              <RotateCwIcon className={cn(loading && "animate-spin")} />
            </Button>
            <Input
              value={q.where}
              placeholder="WHERE 조건 (예: status = 'A')"
              onChange={(e) => patchQuery({ where: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && void reload(0, q)}
              className="h-7 min-w-52 flex-1 text-[13px]"
            />
            <Input
              value={q.orderBy}
              placeholder="ORDER BY (예: id DESC)"
              onChange={(e) => patchQuery({ orderBy: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && void reload(0, q)}
              className="h-7 w-44 text-[13px]"
            />
            <Input
              type="number"
              value={q.limit}
              title="한 번에 읽을 행 수"
              onChange={(e) =>
                patchQuery({
                  limit: Math.max(
                    1,
                    Math.min(5000, Number(e.target.value) || 1)
                  ),
                })
              }
              className="h-7 w-20 text-[13px]"
            />
            <Button
              size="xs"
              disabled={loading}
              onClick={() => void reload(0, q)}
            >
              조회
            </Button>
          </div>

          {/* 툴바 2 — 편집·페이지 */}
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
            <Button
              variant="outline"
              size="xs"
              disabled={!editable}
              title={readOnlyReason ?? "빈 행 추가"}
              onClick={addRow}
            >
              <PlusIcon />행 추가
            </Button>
            <Button
              variant="outline"
              size="xs"
              disabled={!editable || selected.size === 0}
              title={readOnlyReason ?? "선택한 행 삭제 표시"}
              onClick={deleteSelected}
            >
              <Trash2Icon />
              삭제 {selected.size > 0 && `(${selected.size})`}
            </Button>

            <span className="mx-1 h-4 w-px bg-border" />

            <Button
              size="xs"
              disabled={dirtyCount === 0 || loading}
              onClick={() => void commit()}
              title="보류 중인 변경을 한 트랜잭션으로 적용"
            >
              <CheckIcon />
              적용 {dirtyCount > 0 && `(${dirtyCount})`}
            </Button>
            <Button
              variant="outline"
              size="xs"
              disabled={dirtyCount === 0}
              onClick={revert}
              title="보류 중인 변경 버리기"
            >
              <UndoIcon />
              되돌리기
            </Button>

            <span className="mx-1 h-4 w-px bg-border" />

            <Button
              variant="ghost"
              size="xs"
              title="전체 건수 세기 (COUNT(*) — 큰 테이블에서는 느립니다)"
              onClick={() => void loadCount()}
            >
              <SigmaIcon />
              {total === null ? "건수" : total.toLocaleString()}
            </Button>

            <div className="ml-auto flex items-center gap-1">
              <span className="text-[11px] text-muted-foreground">
                {offset + 1}–{offset + rowsOnPage}
                {result?.truncated && " (더 있음)"}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                title="이전 페이지"
                disabled={offset === 0 || loading}
                onClick={() => void load(Math.max(0, offset - pageSize), q)}
              >
                <ChevronLeftIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                title="다음 페이지"
                disabled={loading || rowsOnPage < pageSize}
                onClick={() => void load(offset + pageSize, q)}
              >
                <ChevronRightIcon />
              </Button>
            </div>
          </div>

          {/* 상태 줄 */}
          {(error || notice || readOnlyReason) && (
            <div className="shrink-0 px-4 py-1.5">
              {error && (
                <div className="flex items-start gap-2 rounded-lg bg-ui-error/10 px-2.5 py-1.5 text-[12px] whitespace-pre-wrap text-ui-error">
                  <span className="flex-1">{error}</span>
                  <button onClick={() => setError(null)} title="닫기">
                    <XIcon className="size-3.5" />
                  </button>
                </div>
              )}
              {notice && !error && (
                <div className="flex items-start gap-2 rounded-lg bg-ui-success/10 px-2.5 py-1.5 text-[12px] text-ui-success">
                  <span className="flex-1">{notice}</span>
                  <button onClick={() => setNotice(null)} title="닫기">
                    <XIcon className="size-3.5" />
                  </button>
                </div>
              )}
              {readOnlyReason && !error && !notice && (
                <div className="rounded-lg bg-muted px-2.5 py-1.5 text-[12px] text-muted-foreground">
                  {readOnlyReason}
                </div>
              )}
            </div>
          )}

          {dirtyCount > 0 && (
            <div className="shrink-0 border-b border-border bg-ui-warning/10 px-4 py-1.5 text-[12px] text-foreground">
              보류 중인 변경 {dirtyCount}건 — <b>적용</b>을 눌러야 DB 에
              반영됩니다.
              {!autoCommit &&
                " (수동 커밋 모드: 적용 후 커밋까지 눌러야 합니다.)"}
            </div>
          )}

          {/* 그리드 */}
          <div className="min-h-0 flex-1">
            {result ? (
              <DataGrid
                columns={result.columns}
                rows={gridRows}
                primaryKey={pk}
                editable={editable}
                readOnlyReason={readOnlyReason}
                onCellCommit={onCellCommit}
                selected={selected}
                onToggleSelect={(id) =>
                  setSelected((prev) => {
                    const next = new Set(prev)
                    if (!next.delete(id)) next.add(id)
                    return next
                  })
                }
                emptyText="조건에 맞는 행이 없습니다."
              />
            ) : (
              <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
                {loading ? "읽는 중…" : "조회를 눌러 데이터를 불러오세요."}
              </div>
            )}
          </div>
        </>
      )}

      {sub === "columns" && (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="w-10 px-3 py-2 font-semibold">#</th>
                <th className="px-3 py-2 font-semibold">컬럼</th>
                <th className="px-3 py-2 font-semibold">타입</th>
                <th className="w-20 px-3 py-2 font-semibold">NULL</th>
                <th className="px-3 py-2 font-semibold">기본값</th>
                <th className="px-3 py-2 font-semibold">설명</th>
              </tr>
            </thead>
            <tbody>
              {meta?.columns.map((c) => {
                const isPk = pk.some(
                  (p) => p.toLowerCase() === c.name.toLowerCase()
                )
                return (
                  <tr key={c.name} className="border-b border-border/60">
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {c.position}
                    </td>
                    <td className="px-3 py-1.5 font-mono font-bold">
                      <span className="flex items-center gap-1.5">
                        {isPk && <KeyIcon className="size-3 text-ui-warning" />}
                        {c.name}
                        {c.autoIncrement && (
                          <span className="rounded-full bg-muted px-1.5 text-[10px] font-bold text-muted-foreground">
                            AUTO
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 font-mono text-muted-foreground">
                      {c.typeName}
                      {c.size > 0 &&
                        `(${c.size}${c.digits ? `,${c.digits}` : ""})`}
                    </td>
                    <td className="px-3 py-1.5">
                      {c.nullable ? (
                        <span className="text-muted-foreground">허용</span>
                      ) : (
                        <span className="font-bold text-ui-error">
                          NOT NULL
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-muted-foreground">
                      {c.defaultValue ?? "-"}
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {c.remarks ?? "-"}
                    </td>
                  </tr>
                )
              })}
              {!meta && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-6 text-center text-muted-foreground"
                  >
                    구조를 읽는 중…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {sub === "keys" && (
        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
          <section>
            <h3 className="mb-2 text-[15px] font-semibold">기본키</h3>
            {pk.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">없음</p>
            ) : (
              <p className="font-mono text-[13px]">{pk.join(", ")}</p>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-[15px] font-semibold">
              인덱스 ({meta?.indexes.length ?? 0})
            </h3>
            {meta && meta.indexes.length > 0 ? (
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-3 py-2 font-semibold">이름</th>
                    <th className="w-24 px-3 py-2 font-semibold">유일</th>
                    <th className="px-3 py-2 font-semibold">컬럼</th>
                  </tr>
                </thead>
                <tbody>
                  {meta.indexes.map((idx) => (
                    <tr key={idx.name} className="border-b border-border/60">
                      <td className="px-3 py-1.5 font-mono">{idx.name}</td>
                      <td className="px-3 py-1.5">
                        {idx.unique ? (
                          <span className="font-bold text-ui-info">UNIQUE</span>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-muted-foreground">
                        {idx.columns.join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-[13px] text-muted-foreground">없음</p>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-[15px] font-semibold">
              외래키 ({meta?.foreignKeys.length ?? 0})
            </h3>
            {meta && meta.foreignKeys.length > 0 ? (
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-3 py-2 font-semibold">이름</th>
                    <th className="px-3 py-2 font-semibold">컬럼</th>
                    <th className="px-3 py-2 font-semibold">참조</th>
                  </tr>
                </thead>
                <tbody>
                  {meta.foreignKeys.map((fk, i) => (
                    <tr
                      key={`${fk.name}-${i}`}
                      className="border-b border-border/60"
                    >
                      <td className="px-3 py-1.5 font-mono">
                        {fk.name || "-"}
                      </td>
                      <td className="px-3 py-1.5 font-mono">{fk.column}</td>
                      <td className="px-3 py-1.5 font-mono text-muted-foreground">
                        {fk.refSchema ? `${fk.refSchema}.` : ""}
                        {fk.refTable}.{fk.refColumn}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-[13px] text-muted-foreground">없음</p>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
