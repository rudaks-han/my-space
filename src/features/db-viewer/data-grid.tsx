import { useEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"
import type { Cell, ResultColumn } from "./db-client"

/**
 * 결과 그리드. 쿼리 콘솔에서는 읽기 전용으로, 테이블 뷰에서는 편집 가능하게 쓴다.
 *
 * 편집을 그리드가 직접 저장하지 않는 게 핵심이다 — 값을 바꾸면 `onCellCommit` 만
 * 부르고, 무엇이 보류 중인지는 부모(테이블 패널)가 갖는다. 커밋은 그 보류분을 한
 * 트랜잭션으로 보내는 별도 동작이라, 그리드가 상태를 들고 있으면 "무엇을 커밋할지"가
 * 두 군데로 흩어진다.
 *
 * NULL 과 빈 문자열은 끝까지 구분한다. 화면에서는 `NULL` 칩으로, 값으로는 `null` 로.
 * 이걸 뭉개면 NOT NULL 컬럼에 빈 문자열을 넣어 놓고 왜 안 되는지 모르게 된다.
 */

/** 그리드가 그리는 행 하나. */
export interface GridRow {
  /** 안정적인 식별자 — 기존 행은 기본키에서, 새 행은 임시 id 에서 만든다. */
  id: string
  cells: Cell[]
  state: "normal" | "modified" | "new" | "deleted"
  /** 이 행에서 수정된 컬럼 인덱스(하이라이트용). */
  changed?: Set<number>
}

export interface DataGridProps {
  columns: ResultColumn[]
  rows: GridRow[]
  /** 기본키 컬럼 이름들 — 헤더에 열쇠 표시를 붙인다. */
  primaryKey?: string[]
  editable?: boolean
  /** 편집할 수 없는 이유(있으면 툴팁으로 알려 준다). */
  readOnlyReason?: string | null
  onCellCommit?: (rowId: string, colIndex: number, value: Cell) => void
  selected?: Set<string>
  onToggleSelect?: (rowId: string) => void
  emptyText?: string
}

/** 셀 표시값. null 은 값이 아니라 표식이므로 따로 그린다. */
function CellText({ value, binary }: { value: Cell; binary: boolean }) {
  if (value === null) {
    return (
      <span className="rounded-full bg-muted px-1.5 text-[11px] font-bold text-muted-foreground">
        NULL
      </span>
    )
  }
  if (value === "") {
    return (
      <span className="text-[11px] text-muted-foreground">(빈 문자열)</span>
    )
  }
  return (
    <span className={cn("whitespace-pre", binary && "text-muted-foreground")}>
      {value}
    </span>
  )
}

/**
 * 셀 편집기. 인풋 하나 + NULL 버튼.
 *
 * NULL 버튼이 필요한 이유: 인풋을 비우면 빈 문자열이지 NULL 이 아니다. 키보드만으로도
 * 되도록 편집 중이 아닌 셀에서 Delete 를 눌러도 NULL 이 된다.
 */
function CellEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: Cell
  onCommit: (v: Cell) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initial ?? "")
  const ref = useRef<HTMLInputElement>(null)
  // 커밋과 취소가 겹쳐 두 번 불리지 않게(blur 는 Enter 뒤에도 온다) 한 번만 통과시킨다.
  const done = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const finish = (v: Cell) => {
    if (done.current) return
    done.current = true
    onCommit(v)
  }
  const cancel = () => {
    if (done.current) return
    done.current = true
    onCancel()
  }

  return (
    <div className="flex items-center gap-1">
      <input
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => finish(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            finish(text)
          } else if (e.key === "Escape") {
            e.preventDefault()
            cancel()
          }
        }}
        className="min-w-0 flex-1 rounded border border-ui-selection bg-background px-1 py-0.5 font-mono text-[13px] outline-none"
      />
      <button
        // onMouseDown 이어야 한다 — onClick 은 인풋의 blur 가 먼저 터져서 늦는다.
        onMouseDown={(e) => {
          e.preventDefault()
          finish(null)
        }}
        title="이 셀을 SQL NULL 로"
        className="shrink-0 rounded bg-muted px-1 text-[10px] font-bold text-muted-foreground hover:bg-ui-list-hover"
      >
        NULL
      </button>
    </div>
  )
}

export function DataGrid({
  columns,
  rows,
  primaryKey = [],
  editable = false,
  readOnlyReason = null,
  onCellCommit,
  selected,
  onToggleSelect,
  emptyText = "결과가 없습니다.",
}: DataGridProps) {
  const [editing, setEditing] = useState<{ row: string; col: number } | null>(
    null
  )
  const pkSet = new Set(primaryKey.map((c) => c.toLowerCase()))

  if (columns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
        {emptyText}
      </div>
    )
  }

  const startEdit = (rowId: string, col: number, state: GridRow["state"]) => {
    if (!editable || state === "deleted" || columns[col].binary) return
    setEditing({ row: rowId, col })
  }

  return (
    <div className="h-full overflow-auto">
      <table className="w-max min-w-full border-separate border-spacing-0 text-[13px]">
        <thead className="sticky top-0 z-10">
          <tr>
            <th className="sticky left-0 z-20 w-12 border-r border-b border-border bg-card px-2 py-1.5 text-right text-[11px] font-semibold text-muted-foreground">
              #
            </th>
            {columns.map((c, i) => (
              <th
                key={`${c.name}-${i}`}
                title={`${c.name} · ${c.typeName}`}
                className="border-r border-b border-border bg-card px-2.5 py-1.5 text-left font-semibold whitespace-nowrap"
              >
                <span className="flex items-center gap-1">
                  {pkSet.has(c.name.toLowerCase()) && (
                    <span className="text-ui-warning" title="기본키">
                      🔑
                    </span>
                  )}
                  {c.name}
                  <span className="text-[11px] font-normal text-muted-foreground">
                    {c.typeName}
                  </span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={columns.length + 1}
                className="px-3 py-6 text-center text-[13px] text-muted-foreground"
              >
                {emptyText}
              </td>
            </tr>
          )}
          {rows.map((row, ri) => {
            const isSelected = selected?.has(row.id) ?? false
            return (
              <tr
                key={row.id}
                className={cn(
                  "group",
                  row.state === "new" && "bg-ui-success/10",
                  row.state === "deleted" && "bg-ui-error/10 line-through",
                  isSelected && "bg-ui-selection/15"
                )}
              >
                <td
                  onClick={() => onToggleSelect?.(row.id)}
                  title={onToggleSelect ? "클릭해 행 선택" : undefined}
                  className={cn(
                    "sticky left-0 z-10 border-r border-b border-border bg-card px-2 py-1 text-right text-[11px] text-muted-foreground",
                    onToggleSelect && "cursor-pointer hover:bg-ui-list-hover",
                    isSelected && "bg-ui-selection text-ui-selection-fg"
                  )}
                >
                  {row.state === "new" ? "+" : ri + 1}
                </td>
                {columns.map((col, ci) => {
                  const isEditing =
                    editing?.row === row.id && editing?.col === ci
                  const isChanged = row.changed?.has(ci) ?? false
                  return (
                    <td
                      key={`${col.name}-${ci}`}
                      tabIndex={editable ? 0 : -1}
                      title={
                        !editable && readOnlyReason ? readOnlyReason : undefined
                      }
                      onDoubleClick={() => startEdit(row.id, ci, row.state)}
                      onKeyDown={(e) => {
                        if (isEditing) return
                        if (e.key === "Enter") {
                          e.preventDefault()
                          startEdit(row.id, ci, row.state)
                        } else if (
                          e.key === "Delete" ||
                          e.key === "Backspace"
                        ) {
                          // 포커스만 있는 셀에서 Delete = NULL. 편집기를 열지 않고 바로 반영한다.
                          if (!editable || row.state === "deleted") return
                          e.preventDefault()
                          onCellCommit?.(row.id, ci, null)
                        }
                      }}
                      className={cn(
                        "max-w-[420px] truncate border-r border-b border-border px-2.5 py-1 align-top font-mono",
                        editable &&
                          "cursor-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid",
                        isChanged && "bg-ui-warning/20",
                        isEditing && "bg-background p-0.5"
                      )}
                    >
                      {isEditing ? (
                        <CellEditor
                          initial={row.cells[ci] ?? null}
                          onCommit={(v) => {
                            setEditing(null)
                            onCellCommit?.(row.id, ci, v)
                          }}
                          onCancel={() => setEditing(null)}
                        />
                      ) : (
                        <CellText
                          value={row.cells[ci] ?? null}
                          binary={col.binary}
                        />
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
