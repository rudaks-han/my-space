import { useState } from "react"
import {
  DatabaseIcon,
  EyeIcon,
  LayersIcon,
  Loader2Icon,
  PlugIcon,
  PlugZapIcon,
  RotateCwIcon,
  Settings2Icon,
  TableIcon,
  TerminalIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  isSystemTable,
  type DbConnection,
} from "@/features/db-viewer/connection"
import type { TableRef } from "@/features/db-viewer/db-client"
import { engineById } from "@/features/db-viewer/engines"
import {
  getShowSystem,
  getTableFilter,
  setShowSystem,
  setTableFilter,
} from "@/features/db-viewer/persisted"
import { cn } from "@/lib/utils"
import {
  PanelCount,
  PanelEmpty,
  PanelFilter,
  PanelHeader,
  PanelNote,
  PanelRow,
} from "./panel-tree"
import { DB_SCOPE, tableTabId } from "./types"
import { schemaKeyOf, type DbSession } from "./use-db-session"

/**
 * IntelliJ Cowork 화면의 오른쪽 데이터베이스 패널 — IntelliJ 의 Database 툴윈도 자리다.
 *
 * 여기서 하는 일은 **고르는 것**뿐이다: 접속을 고르고, 스키마를 고르고, 테이블을 눌러
 * 가운데 탭으로 보낸다. 격자(`TablePane`)와 SQL 콘솔(`QueryConsole`)은 이 패널이 아니라
 * 루트가 여는 가운데 탭이다 — 좁은 세로 패널 안에 격자를 넣으면 열도 행도 안 보이고,
 * 무엇보다 "연 것은 전부 가운데 탭 하나로 모인다"는 이 화면의 규칙이 깨진다.
 *
 * 세션(연결·스키마·트랜잭션)은 `useDbSession` 이 주인이고 여기는 받아 쓰기만 한다.
 * 같은 세션을 격자와 콘솔도 보기 때문이다(자동 커밋이 접속의 속성인 것과 같은 이유).
 *
 * 머리줄·검색 칸·줄 부품은 `panel-tree.tsx` 에 있다 — 이 패널은 오른쪽 칸을
 * Elasticsearch·Kafka 장과 **레일로 갈아 끼워** 나눠 쓰므로, 줄 높이나 검색 칸 위치가
 * 장마다 다르면 레일을 누를 때 목록이 위아래로 튀어 다른 화면처럼 보인다.
 */

/** 목록 상태(검색어·시스템 테이블 표시)를 담아 둘 칸. 데이터베이스 뷰어와 나눠 쓰면
 *  한쪽에서 친 검색어가 다른 쪽 목록을 비운다(`persisted.ts` 의 `scopes` 주석 참고).
 *  격자·콘솔의 저장 칸과 **같은 접두사**여야 하므로 `types.ts` 의 상수를 쓴다. */
const SCOPE = DB_SCOPE

const selectClass =
  "h-6 min-w-0 flex-1 rounded-lg border border-input bg-background px-1.5 text-[12px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-ring"

export interface DbPanelProps {
  session: DbSession
  connections: DbConnection[]
  connId: string | null
  /**
   * 가운데에 떠 있는 탭의 id — 이 목록에서 **어느 줄이 눌린 것인지**를 정한다.
   *
   * 패널이 자기 선택을 따로 들지 않는 이유: 클릭이 곧 "가운데에 연다" 이므로 두 값이
   * 갈리면 탭을 옮겼을 때 목록은 여전히 옛 테이블을 가리킨다. 탭 id 는 `tableTabId` 가
   * 만드는 같은 규칙이라 비교만 하면 항상 일치한다.
   */
  activeId: string | null
  onSelectConn: (id: string) => void
  /** 테이블 행 클릭 — 루트가 가운데 `table` 탭으로 연다. */
  onOpenTable: (t: TableRef) => void
  /** 가운데 `sql` 탭(쿼리 콘솔)을 연다. */
  onOpenSql: () => void
  /** 접속 관리 대화상자를 연다(루트가 가지고 있다). */
  onManage: () => void
  className?: string
}

export function DbPanel({
  session,
  connections,
  connId,
  activeId,
  onSelectConn,
  onOpenTable,
  onOpenSql,
  onManage,
  className,
}: DbPanelProps) {
  const conn = connections.find((c) => c.id === connId) ?? null
  const { info, connecting, connError } = session

  const [filter, setFilter] = useState(() => getTableFilter(SCOPE))
  const [showSystem, setShowSystemState] = useState(() => getShowSystem(SCOPE))

  // 트리 접힘. 스키마는 **지금 고른 것만** 펼칠 수 있다 — 목록을 읽어 둔 스키마가
  // 하나뿐이라, 다른 스키마에 화살표를 달아 두면 눌러도 빈 채로 열려 고장처럼 보인다.
  const [rootOpen, setRootOpen] = useState(true)
  const [schemaOpen, setSchemaOpen] = useState(true)
  const [tablesOpen, setTablesOpen] = useState(true)
  const [viewsOpen, setViewsOpen] = useState(true)

  const needle = filter.trim().toLowerCase()
  const visible = session.tables.filter(
    (t) =>
      (showSystem || !isSystemTable(t)) &&
      (!needle || t.name.toLowerCase().includes(needle))
  )
  const tables = visible.filter((t) => !/VIEW/i.test(t.type))
  const views = visible.filter((t) => /VIEW/i.test(t.type))

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-card", className)}>
      {/* ── 머리줄: 접속 고르기 + 동작 ── */}
      <PanelHeader label="데이터베이스">
        {connections.length > 0 && (
          <select
            value={connId ?? ""}
            onChange={(e) => onSelectConn(e.target.value)}
            className={selectClass}
            title="접속 선택"
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {engineById(c.engine).label}
              </option>
            ))}
          </select>
        )}

        <div className="ml-auto flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="icon-xs"
            title={info ? "연결 해제" : "연결"}
            disabled={!conn || connecting}
            onClick={() =>
              void (info ? session.disconnect() : session.connect())
            }
          >
            {info ? <PlugZapIcon className="text-ui-success" /> : <PlugIcon />}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            title="테이블 목록 새로고침"
            disabled={!info || session.loadingTables}
            onClick={() => void session.reloadTables()}
          >
            <RotateCwIcon
              className={cn(session.loadingTables && "animate-spin")}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            title="SQL 콘솔 열기"
            disabled={!info}
            onClick={onOpenSql}
          >
            <TerminalIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            title="접속 관리"
            onClick={onManage}
          >
            <Settings2Icon />
          </Button>
        </div>
      </PanelHeader>

      {/* ── 본문: 상태마다 다른 몸통을 그린다 ──
          바쁜 표시를 낡은 목록 위에 덧씌우지 않는다 — 연결이 끊긴 채 남아 있는
          테이블 이름을 누르면 열리지 않는 탭이 생기고, 그게 왜인지 알 길이 없다. */}
      {connections.length === 0 ? (
        <PanelEmpty
          icon={DatabaseIcon}
          title="저장된 접속이 없습니다"
          desc="접속 관리에서 데이터베이스를 하나 등록하세요."
          action={
            <Button variant="outline" size="xs" onClick={onManage}>
              <Settings2Icon />
              접속 관리
            </Button>
          }
        />
      ) : connecting ? (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-[13px] text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" />
          연결 중…
        </div>
      ) : !info ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
          <Button
            size="sm"
            disabled={!conn}
            onClick={() => void session.connect()}
          >
            <PlugIcon />
            {conn ? `${conn.name} 에 연결` : "연결"}
          </Button>
          <p className="text-[11px] text-muted-foreground">
            비밀번호가 필요한 접속은 <b>접속 관리</b>에서 한 번 연결해 두면 이
            버튼만으로 붙습니다.
          </p>
          {connError && (
            <div className="rounded-lg bg-ui-error/10 px-2.5 py-1.5 text-[12px] whitespace-pre-wrap text-ui-error">
              {connError}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* 검색 + 시스템 테이블 */}
          <div className="shrink-0 px-2 pt-1.5">
            <PanelFilter
              value={filter}
              placeholder="테이블 검색…"
              onChange={(v) => {
                setFilter(v)
                setTableFilter(v, SCOPE)
              }}
            />
            <label className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                checked={showSystem}
                onChange={(e) => {
                  setShowSystemState(e.target.checked)
                  setShowSystem(e.target.checked, SCOPE)
                }}
              />
              시스템 테이블 표시
            </label>
          </div>

          {/* 트리: 접속 → 스키마 → 테이블 / 뷰 */}
          <div className="min-h-0 flex-1 overflow-auto p-1">
            <PanelRow
              depth={0}
              expandable
              expanded={rootOpen}
              onToggle={() => setRootOpen((v) => !v)}
              icon={DatabaseIcon}
              label={conn?.name ?? info.product}
              title={`${info.product} ${info.productVersion}`}
              right={
                <span className="shrink-0 truncate text-[10px] text-muted-foreground">
                  {info.product}
                </span>
              }
              onClick={() => setRootOpen((v) => !v)}
            />

            {rootOpen &&
              (session.schemas.length === 0 ? (
                <PanelNote depth={1}>스키마가 없습니다.</PanelNote>
              ) : (
                session.schemas.map((s) => {
                  const key = schemaKeyOf(s)
                  const picked = key === session.schemaKey
                  return (
                    <div key={key}>
                      <PanelRow
                        depth={1}
                        expandable={picked}
                        expanded={picked && schemaOpen}
                        onToggle={() => setSchemaOpen((v) => !v)}
                        icon={LayersIcon}
                        label={s.label}
                        title={s.label}
                        selected={picked}
                        onClick={() => {
                          if (picked) {
                            setSchemaOpen((v) => !v)
                            return
                          }
                          // 고른 스키마의 목록을 새로 읽는다 — 접혀 있으면 읽어도
                          // 보이지 않으므로 같이 펼친다.
                          setSchemaOpen(true)
                          session.setSchemaKey(key)
                        }}
                      />

                      {picked && schemaOpen && (
                        <>
                          <PanelRow
                            depth={2}
                            expandable
                            expanded={tablesOpen}
                            onToggle={() => setTablesOpen((v) => !v)}
                            icon={TableIcon}
                            label="테이블"
                            right={<PanelCount n={tables.length} />}
                            onClick={() => setTablesOpen((v) => !v)}
                          />
                          {tablesOpen &&
                            (session.loadingTables ? (
                              <PanelNote depth={3}>읽는 중…</PanelNote>
                            ) : tables.length === 0 ? (
                              <PanelNote depth={3}>
                                {needle
                                  ? "검색과 일치하는 테이블이 없습니다."
                                  : "테이블이 없습니다."}
                              </PanelNote>
                            ) : (
                              tables.map((t) => (
                                <PanelRow
                                  key={`${t.catalog ?? ""}.${t.schema ?? ""}.${t.name}`}
                                  depth={3}
                                  icon={TableIcon}
                                  label={t.name}
                                  title={`${t.name} · ${t.type}${t.remarks ? ` · ${t.remarks}` : ""}`}
                                  selected={
                                    connId != null &&
                                    tableTabId(connId, t) === activeId
                                  }
                                  onClick={() => onOpenTable(t)}
                                />
                              ))
                            ))}

                          {views.length > 0 && (
                            <>
                              <PanelRow
                                depth={2}
                                expandable
                                expanded={viewsOpen}
                                onToggle={() => setViewsOpen((v) => !v)}
                                icon={EyeIcon}
                                label="뷰"
                                right={<PanelCount n={views.length} />}
                                onClick={() => setViewsOpen((v) => !v)}
                              />
                              {viewsOpen &&
                                views.map((t) => (
                                  <PanelRow
                                    key={`${t.catalog ?? ""}.${t.schema ?? ""}.${t.name}`}
                                    depth={3}
                                    icon={EyeIcon}
                                    label={t.name}
                                    title={`${t.name} · ${t.type}`}
                                    selected={
                                      connId != null &&
                                      tableTabId(connId, t) === activeId
                                    }
                                    onClick={() => onOpenTable(t)}
                                  />
                                ))}
                            </>
                          )}
                        </>
                      )}
                    </div>
                  )
                })
              ))}
          </div>

          {/* 목록을 읽다 실패한 경우에도 트리는 남겨 두고 아래에 이유만 붙인다. */}
          {connError && (
            <div className="shrink-0 border-t border-border px-2 py-1.5 text-[11px] whitespace-pre-wrap text-ui-error">
              {connError}
            </div>
          )}
        </>
      )}
    </div>
  )
}
