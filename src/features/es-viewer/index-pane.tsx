import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronsUpDownIcon,
  RotateCcwIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { EsClient, EsError, type Hit, type IndexRow } from "./es-client"
import {
  asEpochDate,
  cellText,
  defaultColumns,
  effectiveFields,
  extractFieldInfo,
  fmtBytes,
  fmtNum,
  isSortable,
  isSortFieldError,
  type FieldInfoMap,
} from "./es-utils"
import {
  clearIndexColumns,
  getIndexColumns,
  getIndexDsl,
  getIndexQuery,
  getIndexSort,
  getPageSize,
  getSearchMode,
  setIndexColumns,
  setIndexDsl,
  setIndexQuery,
  setIndexSort,
  setPageSize,
  setSearchMode as persistSearchMode,
  type SearchMode,
  type SortSpec,
} from "./persisted"
import { DslEditor } from "./dsl-editor"
import { DocModal, type EditableDoc } from "./doc-modal"
import { ConfirmDialog } from "./confirm-dialog"

interface SearchError {
  message: string
  detail?: string
}

interface ModalState {
  title: string
  value: unknown
  editable?: EditableDoc | null
}

const PAGE_SIZES = [10, 25, 50, 100]

/**
 * 인덱스 하나를 조회하는 화면. 탭은 keep-alive 라 이 컴포넌트는 마운트된 채 남는다
 * (탭을 다시 눌러도 이전 검색어·정렬·결과·스크롤을 그대로 유지). 그래서 각 인덱스별
 * 검색 상태를 이 컴포넌트가 직접 소유하고, 활성 여부는 CSS(invisible)로만 토글한다.
 */
export function IndexPane({
  index,
  client,
  meta,
  active,
  onDeleted,
  onDocsChanged,
}: {
  index: string
  client: EsClient
  meta?: IndexRow
  active: boolean
  onDeleted: (index: string) => void
  onDocsChanged: () => void
}) {
  const [fieldInfo, setFieldInfo] = useState<FieldInfoMap>({})
  const [masterFields, setMasterFields] = useState<string[]>([])
  const [columns, setColumns] = useState<string[]>([])
  const [hits, setHits] = useState<Hit[]>([])
  const [total, setTotal] = useState(0)
  const [from, setFrom] = useState(0)
  const [size, setSize] = useState(() => getPageSize())
  const [mode, setMode] = useState<SearchMode>(() => getSearchMode())
  const [query, setQuery] = useState(() => getIndexQuery(index))
  const [dsl, setDsl] = useState(() => getIndexDsl(index))
  const [sort, setSort] = useState<SortSpec | null>(() => getIndexSort(index))
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [view, setView] = useState<"table" | "json">("table")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<SearchError | null>(null)
  const [colsOpen, setColsOpen] = useState(false)
  const [modal, setModal] = useState<ModalState | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null)

  const colsBtnRef = useRef<HTMLDivElement>(null)
  const didDragRef = useRef(false)
  const dragField = useRef<string | null>(null)

  const fields = effectiveFields(masterFields, hits)

  /* ── 검색 실행 ── */
  const performSearch = useCallback(
    async (p: {
      query: string
      dsl: string
      mode: SearchMode
      sort: SortSpec | null
      from: number
      size: number
      fieldInfo: FieldInfoMap
    }) => {
      setLoading(true)
      setError(null)
      setSelected(new Set())

      let dslObj: unknown = null
      if (p.mode === "dsl") {
        const text = p.dsl.trim()
        if (text) {
          let parsed: unknown
          try {
            parsed = JSON.parse(text)
          } catch (e) {
            setError({
              message: "Query DSL JSON 파싱 오류",
              detail:
                (e as Error).message + "\n\n올바른 JSON 형식인지 확인하세요.",
            })
            setLoading(false)
            return
          }
          dslObj =
            parsed &&
            typeof parsed === "object" &&
            (parsed as { query?: unknown }).query
              ? (parsed as { query: unknown }).query
              : parsed
        }
      }

      const doSearch = (sortClause: unknown) =>
        client.search(index, {
          query: p.mode === "dsl" ? undefined : p.query,
          dsl: dslObj,
          from: p.from,
          size: p.size,
          sort: sortClause,
        })

      try {
        let res
        if (p.sort?.field && p.sort.order) {
          const info = p.fieldInfo[p.sort.field]
          const path =
            info && info.type === "text" && info.hasKeyword
              ? `${p.sort.field}.keyword`
              : p.sort.field
          try {
            res = await doSearch([
              { [path]: { order: p.sort.order, unmapped_type: "keyword" } },
            ])
          } catch (err) {
            if (
              err instanceof EsError &&
              isSortFieldError(err.detail) &&
              !path.endsWith(".keyword")
            ) {
              res = await doSearch([
                {
                  [`${p.sort.field}.keyword`]: {
                    order: p.sort.order,
                    unmapped_type: "keyword",
                  },
                },
              ])
            } else {
              throw err
            }
          }
        } else {
          res = await doSearch(null)
        }
        const hitsObj = res.hits ?? {}
        setHits(hitsObj.hits ?? [])
        setTotal(
          typeof hitsObj.total === "object"
            ? hitsObj.total.value
            : (hitsObj.total ?? 0)
        )
        setFrom(p.from)
      } catch (err) {
        if (err instanceof EsError) {
          setError({
            message: err.message,
            detail:
              typeof err.detail === "string"
                ? err.detail
                : JSON.stringify(err.raw, null, 2),
          })
        } else {
          setError({ message: String(err) })
        }
      } finally {
        setLoading(false)
      }
    },
    [client, index]
  )

  /** 현재 state 로 검색(선택적으로 from 을 덮어씀). */
  const runSearch = useCallback(
    (fromOverride?: number) =>
      performSearch({
        query,
        dsl,
        mode,
        sort,
        from: fromOverride ?? from,
        size,
        fieldInfo,
      }),
    [performSearch, query, dsl, mode, sort, from, size, fieldInfo]
  )

  /* ── 최초 로드: 매핑 → 컬럼 구성 → 검색 ── */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      let fInfo: FieldInfoMap = {}
      let master: string[] = []
      try {
        const res = await client.mapping(index)
        fInfo = extractFieldInfo(index, res)
        master = Object.keys(fInfo).sort()
      } catch {
        // 매핑 실패 시엔 결과의 _source 키로 대체(effectiveFields 가 처리)
      }
      if (cancelled) return
      setFieldInfo(fInfo)
      setMasterFields(master)
      const savedCols = getIndexColumns(index)
      setColumns(savedCols ?? defaultColumns(master, fInfo, []))
      await performSearch({
        query: getIndexQuery(index),
        dsl: getIndexDsl(index),
        mode: getSearchMode(),
        sort: getIndexSort(index),
        from: 0,
        size: getPageSize(),
        fieldInfo: fInfo,
      })
    })()
    return () => {
      cancelled = true
    }
    // 인덱스별로 한 번만.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── 정렬 ── */
  const applySort = (field: string | null, order: "asc" | "desc") => {
    const next: SortSpec | null = field ? { field, order } : null
    setSort(next)
    setIndexSort(index, next)
    performSearch({ query, dsl, mode, sort: next, from: 0, size, fieldInfo })
  }
  // 헤더 클릭: 오름차순 → 내림차순 → 해제.
  const toggleSort = (field: string) => {
    if (sort?.field !== field) applySort(field, "asc")
    else if (sort.order === "asc") applySort(field, "desc")
    else applySort(null, "asc")
  }

  /* ── 페이지 ── */
  const gotoPage = (nextFrom: number) => {
    const f = Math.max(0, nextFrom)
    setFrom(f)
    runSearch(f)
  }
  const changeSize = (n: number) => {
    setSize(n)
    setPageSize(n)
    performSearch({ query, dsl, mode, sort, from: 0, size: n, fieldInfo })
  }
  const changeMode = (m: SearchMode) => {
    setMode(m)
    persistSearchMode(m)
  }

  /* ── 컬럼 ── */
  const toggleColumn = (field: string, on: boolean) => {
    const next = on
      ? columns.includes(field)
        ? columns
        : [...columns, field]
      : columns.filter((f) => f !== field)
    setColumns(next)
    setIndexColumns(index, next)
  }
  const setAllColumns = (on: boolean) => {
    const next = on ? fields.slice() : []
    setColumns(next)
    setIndexColumns(index, next)
  }
  const resetColumns = () => {
    clearIndexColumns(index)
    setColumns(defaultColumns(masterFields, fieldInfo, hits))
    toast.success("컬럼이 기본값으로 초기화되었습니다.")
  }
  const reorderColumns = (fromF: string, toF: string) => {
    if (!fromF || !toF || fromF === toF) return
    const fi = columns.indexOf(fromF)
    const tiOrig = columns.indexOf(toF)
    if (fi < 0 || tiOrig < 0) return
    const cols = columns.filter((f) => f !== fromF)
    const ti = cols.indexOf(toF)
    cols.splice(fi < tiOrig ? ti + 1 : ti, 0, fromF)
    setColumns(cols)
    setIndexColumns(index, cols)
  }

  // 컬럼 패널 바깥 클릭 시 닫기.
  useEffect(() => {
    if (!colsOpen) return
    const onDown = (e: MouseEvent) => {
      if (!colsBtnRef.current?.contains(e.target as Node)) setColsOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [colsOpen])

  /* ── 선택/삭제 ── */
  const toggleRow = (id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }
  const toggleAll = (on: boolean) => {
    setSelected(on ? new Set(hits.map((h) => h._id)) : new Set())
  }
  const askDeleteSelected = () => {
    if (selected.size === 0) return
    setPendingDelete([...selected])
  }
  const doDeleteSelected = async () => {
    const ids = pendingDelete
    setPendingDelete(null)
    if (!ids || ids.length === 0) return
    try {
      const res = await client.deleteByIds(index, ids)
      const deleted = typeof res.deleted === "number" ? res.deleted : ids.length
      setSelected(new Set())
      // 삭제로 현재 페이지가 넘칠 수 있으니 from 보정.
      let f = from
      const newTotal = Math.max(0, total - deleted)
      while (f > 0 && f >= newTotal) f = Math.max(0, f - size)
      toast.success(`${fmtNum(deleted)}개 문서를 삭제했습니다.`)
      await runSearch(f)
      onDocsChanged()
    } catch (err) {
      toast.error("삭제 실패: " + errText(err))
    }
  }

  /* ── 인덱스 정보 / 삭제 ── */
  const showInfo = async (kind: "settings" | "mapping") => {
    try {
      const data =
        kind === "settings"
          ? await client.settings(index)
          : await client.mapping(index)
      setModal({ title: `${index} · _${kind}`, value: data })
    } catch (err) {
      toast.error(`_${kind} 조회 실패: ` + errText(err))
    }
  }
  const doDeleteIndex = async () => {
    setDeleteConfirm(false)
    try {
      await client.deleteIndex(index)
      toast.success(`인덱스 "${index}" 이(가) 삭제되었습니다.`)
      onDeleted(index)
    } catch (err) {
      toast.error("삭제 실패: " + errText(err))
    }
  }

  /* ── 문서 상세 / 편집 ── */
  const openDoc = (hit: Hit) => {
    const editable: EditableDoc = {
      source: hit._source,
      onSave: async (src) => {
        await client.updateDoc(hit._index, hit._id, src)
        setHits((prev) =>
          prev.map((h) => (h._id === hit._id ? { ...h, _source: src } : h))
        )
        setModal({
          title: `_id: ${hit._id}`,
          value: { _index: hit._index, _id: hit._id, _source: src },
          editable: {
            source: src,
            onSave: editable.onSave,
          },
        })
        toast.success("문서를 수정했습니다.")
      },
    }
    setModal({
      title: `_id: ${hit._id}`,
      value: {
        _index: hit._index,
        _id: hit._id,
        _score: hit._score,
        _source: hit._source,
      },
      editable,
    })
  }

  const start = from + 1
  const end = from + hits.length

  return (
    <div
      className={cn("absolute inset-0 flex flex-col", !active && "invisible")}
      aria-hidden={!active}
    >
      {/* 헤더: 인덱스명 · 메타 · 정보/삭제 · 뷰 토글 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5">
        <h2 className="text-[15px] font-bold">{index}</h2>
        <button
          onClick={() => showInfo("settings")}
          className="rounded-md px-1.5 py-0.5 text-[13px] font-semibold text-muted-foreground hover:bg-ui-list-hover"
        >
          _settings
        </button>
        <button
          onClick={() => showInfo("mapping")}
          className="rounded-md px-1.5 py-0.5 text-[13px] font-semibold text-muted-foreground hover:bg-ui-list-hover"
        >
          _mapping
        </button>
        {meta && (
          <span className="text-[13px] text-muted-foreground">
            문서 {fmtNum(meta["docs.count"])}개 · 크기{" "}
            {fmtBytes(meta["store.size"])} · health: {meta.health}
          </span>
        )}
        <div className="ms-auto flex items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-border">
            {(["table", "json"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={cn(
                  "px-2.5 py-1 text-[13px] font-bold transition-colors",
                  view === v
                    ? "bg-ui-selection text-ui-selection-fg"
                    : "bg-background text-muted-foreground hover:bg-ui-list-hover"
                )}
              >
                {v === "table" ? "테이블" : "JSON"}
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="xs"
            onClick={() => setDeleteConfirm(true)}
            className="text-ui-error"
          >
            <Trash2Icon />
            인덱스 삭제
          </Button>
        </div>
      </div>

      {/* 조건바 */}
      <div className="flex flex-col gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-start gap-2">
          <div className="flex overflow-hidden rounded-lg border border-border">
            {(["simple", "dsl"] as const).map((m) => (
              <button
                key={m}
                onClick={() => changeMode(m)}
                className={cn(
                  "px-2.5 py-1 text-[13px] font-bold transition-colors",
                  mode === m
                    ? "bg-ui-selection text-ui-selection-fg"
                    : "bg-background text-muted-foreground hover:bg-ui-list-hover"
                )}
              >
                {m === "simple" ? "간편" : "쿼리 DSL"}
              </button>
            ))}
          </div>
          <div className="flex-1">
            {mode === "simple" ? (
              <Input
                value={query}
                placeholder="검색어 (예: field:value, 비우면 전체 조회)"
                onChange={(e) => {
                  setQuery(e.target.value)
                  setIndexQuery(index, e.target.value)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") runSearch(0)
                }}
              />
            ) : (
              <DslEditor
                value={dsl}
                onChange={(v) => {
                  setDsl(v)
                  setIndexDsl(index, v)
                }}
                onRun={() => runSearch(0)}
                fields={fields}
                fieldInfo={fieldInfo}
              />
            )}
          </div>
          <Button size="sm" onClick={() => runSearch(0)}>
            <SearchIcon />
            검색
          </Button>
        </div>

        {/* 정렬 · 페이지 크기 · 컬럼 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">정렬</span>
            <select
              value={sort?.field ?? ""}
              onChange={(e) =>
                applySort(e.target.value || null, sort?.order ?? "asc")
              }
              className="h-7 rounded-lg border border-input bg-background px-2 text-[13px] outline-none focus-visible:border-ring"
            >
              <option value="">기본(관련도)</option>
              {fields
                .filter((f) => isSortable(f, fieldInfo))
                .map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
            </select>
            <button
              disabled={!sort?.field}
              onClick={() =>
                sort?.field &&
                applySort(sort.field, sort.order === "asc" ? "desc" : "asc")
              }
              className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 font-semibold hover:bg-ui-list-hover disabled:opacity-40"
            >
              {sort?.order === "desc" ? (
                <>
                  <ArrowDownIcon className="size-3.5" />
                  내림차순
                </>
              ) : (
                <>
                  <ArrowUpIcon className="size-3.5" />
                  오름차순
                </>
              )}
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">표시</span>
            <select
              value={size}
              onChange={(e) => changeSize(parseInt(e.target.value, 10))}
              className="h-7 rounded-lg border border-input bg-background px-2 text-[13px] outline-none focus-visible:border-ring"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}개
                </option>
              ))}
            </select>
          </div>

          <div
            ref={colsBtnRef}
            className="relative ms-auto flex items-center gap-1.5"
          >
            <button
              onClick={resetColumns}
              title="컬럼 순서와 선택을 기본값으로 되돌립니다"
              className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 font-semibold text-muted-foreground hover:bg-ui-list-hover"
            >
              <RotateCcwIcon className="size-3.5" />
              초기화
            </button>
            <button
              onClick={() => setColsOpen((o) => !o)}
              className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2 py-1 font-bold hover:bg-ui-list-hover"
            >
              컬럼 ({columns.length})
              <ChevronDownIcon className="size-3.5" />
            </button>
            {colsOpen && (
              <div className="absolute top-full right-0 z-20 mt-1 max-h-80 w-72 overflow-auto rounded-lg border border-border bg-popover p-1.5 shadow-[0_4px_16px_rgba(0,0,0,0.16)]">
                <div className="flex items-center justify-between px-2 py-1 text-[13px] font-semibold">
                  <span>표시할 컬럼</span>
                  <div className="flex gap-1">
                    <button
                      onClick={() => setAllColumns(true)}
                      className="rounded-md px-1.5 py-0.5 text-[12px] text-ui-link hover:bg-ui-list-hover"
                    >
                      전체
                    </button>
                    <button
                      onClick={() => setAllColumns(false)}
                      className="rounded-md px-1.5 py-0.5 text-[12px] text-ui-link hover:bg-ui-list-hover"
                    >
                      해제
                    </button>
                  </div>
                </div>
                {fields.length === 0 ? (
                  <div className="px-2 py-2 text-[13px] text-muted-foreground">
                    필드 정보가 없습니다.
                  </div>
                ) : (
                  fields.map((f) => (
                    <label
                      key={f}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-ui-list-hover"
                    >
                      <input
                        type="checkbox"
                        checked={columns.includes(f)}
                        onChange={(e) => toggleColumn(f, e.target.checked)}
                      />
                      <span className="flex-1 truncate">{f}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {fieldInfo[f]?.type ?? ""}
                      </span>
                    </label>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 결과 영역 */}
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="p-6 text-[13px] text-muted-foreground">조회 중…</div>
        ) : error ? (
          <div className="m-4 rounded-lg border border-ui-error/40 bg-ui-error/5 p-4">
            <div className="text-[15px] font-bold text-ui-error">
              {error.message}
            </div>
            {error.detail && (
              <pre className="mt-2 overflow-auto font-mono text-[12px] whitespace-pre-wrap text-muted-foreground">
                {error.detail}
              </pre>
            )}
          </div>
        ) : hits.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
            <p className="text-[15px] font-bold">결과가 없습니다</p>
            <p className="text-[13px] text-muted-foreground">
              조건에 맞는 문서를 찾지 못했습니다.
            </p>
          </div>
        ) : (
          <div className="p-4">
            {/* 결과 요약 · 선택 액션 */}
            <div className="mb-2 flex items-center gap-3 text-[13px]">
              <span className="text-muted-foreground">
                전체{" "}
                <strong className="text-foreground">{fmtNum(total)}</strong>개
                중 {start}–{end} 표시
              </span>
              {selected.size > 0 && (
                <div className="ms-auto flex items-center gap-2">
                  <span className="font-semibold">
                    {fmtNum(selected.size)}개 선택됨
                  </span>
                  <Button
                    variant="outline"
                    size="xs"
                    className="text-ui-error"
                    onClick={askDeleteSelected}
                  >
                    선택 삭제
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setSelected(new Set())}
                  >
                    선택 해제
                  </Button>
                </div>
              )}
            </div>

            {view === "json" ? (
              <div className="flex flex-col gap-3">
                {hits.map((h) => (
                  <div
                    key={h._id}
                    className="overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
                  >
                    <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-[12px] font-semibold text-muted-foreground">
                      _id: <span className="text-foreground">{h._id}</span>
                    </div>
                    <pre className="overflow-auto p-3 font-mono text-[12px] leading-relaxed">
                      {JSON.stringify(h._source, null, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            ) : (
              <ResultTable
                hits={hits}
                columns={columns}
                fieldInfo={fieldInfo}
                sort={sort}
                selected={selected}
                onToggleRow={toggleRow}
                onToggleAll={toggleAll}
                onSort={toggleSort}
                onOpenDoc={openDoc}
                didDragRef={didDragRef}
                dragField={dragField}
                onReorder={reorderColumns}
              />
            )}
          </div>
        )}
      </div>

      {/* 페이지네이션 */}
      {!loading && !error && total > 0 && (
        <div className="flex items-center justify-center gap-3 border-t border-border px-4 py-2 text-[13px]">
          <Button
            variant="outline"
            size="xs"
            disabled={from <= 0}
            onClick={() => gotoPage(from - size)}
          >
            ← 이전
          </Button>
          <span className="text-muted-foreground">
            {fmtNum(start)}–{fmtNum(end)} / {fmtNum(total)}
          </span>
          <Button
            variant="outline"
            size="xs"
            disabled={from + size >= total}
            onClick={() => gotoPage(from + size)}
          >
            다음 →
          </Button>
        </div>
      )}

      {modal && (
        <DocModal
          title={modal.title}
          value={modal.value}
          editable={modal.editable}
          onClose={() => setModal(null)}
        />
      )}

      {deleteConfirm && (
        <ConfirmDialog
          title="인덱스 삭제"
          confirmLabel="영구 삭제"
          requireText={index}
          onCancel={() => setDeleteConfirm(false)}
          onConfirm={doDeleteIndex}
        >
          이 작업은 <strong>되돌릴 수 없습니다.</strong> 인덱스{" "}
          <strong className="text-ui-error">{index}</strong> 와(과) 그 안의 모든
          문서가 영구적으로 삭제됩니다.
        </ConfirmDialog>
      )}

      {pendingDelete !== null && (
        <ConfirmDialog
          title="문서 삭제"
          confirmLabel="삭제"
          onCancel={() => setPendingDelete(null)}
          onConfirm={doDeleteSelected}
        >
          선택한 문서 {fmtNum(pendingDelete.length)}개를 삭제합니다. 이 작업은
          되돌릴 수 없습니다.
        </ConfirmDialog>
      )}
    </div>
  )
}

function errText(err: unknown): string {
  if (err instanceof EsError) return err.detail || err.message
  return String(err)
}

/* ----------------------- 결과 테이블 ----------------------- */
function ResultTable({
  hits,
  columns,
  fieldInfo,
  sort,
  selected,
  onToggleRow,
  onToggleAll,
  onSort,
  onOpenDoc,
  didDragRef,
  dragField,
  onReorder,
}: {
  hits: Hit[]
  columns: string[]
  fieldInfo: FieldInfoMap
  sort: SortSpec | null
  selected: Set<string>
  onToggleRow: (id: string, on: boolean) => void
  onToggleAll: (on: boolean) => void
  onSort: (field: string) => void
  onOpenDoc: (hit: Hit) => void
  didDragRef: React.RefObject<boolean>
  dragField: React.RefObject<string | null>
  onReorder: (from: string, to: string) => void
}) {
  const allChecked = hits.length > 0 && hits.every((h) => selected.has(h._id))
  const someChecked = hits.some((h) => selected.has(h._id))
  const selAllRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (selAllRef.current)
      selAllRef.current.indeterminate = someChecked && !allChecked
  }, [someChecked, allChecked])

  return (
    <div className="overflow-x-auto rounded-[10px] border border-border">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-left">
            <th className="w-9 px-2 py-2">
              <input
                ref={selAllRef}
                type="checkbox"
                checked={allChecked}
                onChange={(e) => onToggleAll(e.target.checked)}
                title="현재 페이지 전체 선택"
              />
            </th>
            <th className="px-3 py-2 font-bold whitespace-nowrap">_id</th>
            {columns.map((c) => {
              const sortable = isSortable(c, fieldInfo)
              const activeSort = sort?.field === c
              return (
                <th
                  key={c}
                  draggable
                  data-field={c}
                  onDragStart={() => {
                    dragField.current = c
                    didDragRef.current = true
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragField.current) onReorder(dragField.current, c)
                  }}
                  onDragEnd={() => {
                    setTimeout(() => {
                      didDragRef.current = false
                      dragField.current = null
                    }, 0)
                  }}
                  onClick={() => {
                    if (didDragRef.current) return
                    if (sortable) onSort(c)
                  }}
                  title={
                    sortable
                      ? "클릭: 정렬 · 드래그: 순서 변경"
                      : `${c} · 드래그로 순서 변경`
                  }
                  className={cn(
                    "cursor-pointer px-3 py-2 font-bold whitespace-nowrap select-none hover:bg-ui-list-hover",
                    activeSort && "text-ui-link"
                  )}
                >
                  <span className="inline-flex items-center gap-1">
                    {c}
                    {sortable &&
                      (activeSort ? (
                        sort?.order === "asc" ? (
                          <ArrowUpIcon className="size-3" />
                        ) : (
                          <ArrowDownIcon className="size-3" />
                        )
                      ) : (
                        <ChevronsUpDownIcon className="size-3 opacity-30" />
                      ))}
                  </span>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {hits.map((h) => {
            const src = h._source ?? {}
            const isSel = selected.has(h._id)
            return (
              <tr
                key={h._id}
                onClick={() => onOpenDoc(h)}
                className={cn(
                  "cursor-pointer border-b border-border/60 last:border-0 hover:bg-ui-list-hover",
                  isSel && "bg-ui-selection/10"
                )}
              >
                <td
                  className="px-2 py-1.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={isSel}
                    onChange={(e) => onToggleRow(h._id, e.target.checked)}
                  />
                </td>
                <td className="px-3 py-1.5 font-mono whitespace-nowrap text-muted-foreground">
                  {h._id}
                </td>
                {columns.map((c) => (
                  <td
                    key={c}
                    title={cellText(src[c])}
                    className="max-w-xs truncate px-3 py-1.5"
                  >
                    <Cell value={src[c]} field={c} />
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
      {columns.length === 0 && (
        <div className="px-3 py-2 text-[13px] text-muted-foreground">
          표시할 컬럼이 없습니다. 우측 상단 <strong>컬럼</strong>에서
          선택하세요.
        </div>
      )}
    </div>
  )
}

/** 셀 값 표시 — 객체는 {…}, 배열은 [n], epoch 날짜 필드는 사람이 읽는 날짜로. */
function Cell({ value, field }: { value: unknown; field: string }) {
  if (value === null || value === undefined || value === "")
    return <span className="text-muted-foreground">—</span>
  if (Array.isArray(value))
    return value.length === 0 ? (
      <span className="text-muted-foreground">[]</span>
    ) : (
      <span className="rounded-full bg-muted px-1.5 text-[11px] font-semibold text-muted-foreground">
        [{value.length}]
      </span>
    )
  if (typeof value === "object")
    return (
      <span className="rounded-full bg-muted px-1.5 text-[11px] font-semibold text-muted-foreground">
        {"{…}"}
      </span>
    )
  if (typeof value === "boolean")
    return <span className="text-ui-info">{String(value)}</span>
  const d = asEpochDate(field, value)
  if (d)
    return (
      <span title={String(value)}>
        {d}{" "}
        <span className="text-[11px] text-muted-foreground">
          ({String(value)})
        </span>
      </span>
    )
  return <>{String(value)}</>
}
