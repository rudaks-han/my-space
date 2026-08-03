/**
 * 테이블별 조회 조건과 콘솔의 SQL 본문을 localStorage 에 직접 읽고 쓴다.
 *
 * ES·Kafka 뷰어의 `persisted.ts` 와 같은 이유 — 타이핑마다 바뀌는 값을 상위 state 로
 * 올리면 keep-alive 로 살아 있는 모든 탭이 함께 리렌더된다. 조회 조건은 각 패널의
 * 로컬 state 로 두고 저장만 여기서 한다.
 */

const KEY = "myspace.dbViewer"

/** 테이블 탭 하나의 조회 조건. */
export interface TableQuery {
  /** WHERE 절 본문(WHERE 키워드 제외). */
  where: string
  /** ORDER BY 절 본문. */
  orderBy: string
  /** 한 페이지 행 수. */
  limit: number
}

export const DEFAULT_TABLE_QUERY: TableQuery = {
  where: "",
  orderBy: "",
  limit: 200,
}

interface DbPersisted {
  /** 키는 `<접속 id>:<카탈로그>.<스키마>.<테이블>`. */
  queries: Record<string, TableQuery>
  /** 키는 접속 id. 콘솔에 써 둔 SQL. */
  consoleSql: Record<string, string>
  /** 왼쪽 테이블 목록 검색어. */
  tableFilter: string
  /** 시스템 테이블(INFORMATION_SCHEMA 등)을 목록에 넣을지. */
  showSystem: boolean
}

const DEFAULTS: DbPersisted = {
  queries: {},
  consoleSql: {},
  tableFilter: "",
  showSystem: false,
}

function read(): DbPersisted {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<DbPersisted>) }
  } catch {
    return { ...DEFAULTS }
  }
}

function write(p: DbPersisted) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    // 저장 실패는 무시(용량 초과 등)
  }
}

export function getTableQuery(key: string): TableQuery {
  return { ...DEFAULT_TABLE_QUERY, ...(read().queries[key] ?? {}) }
}

export function setTableQuery(key: string, q: TableQuery) {
  const p = read()
  p.queries[key] = q
  write(p)
}

export function purgeTableQuery(key: string) {
  const p = read()
  delete p.queries[key]
  write(p)
}

export function getConsoleSql(connId: string): string {
  return read().consoleSql[connId] ?? ""
}

export function setConsoleSql(connId: string, sql: string) {
  const p = read()
  p.consoleSql[connId] = sql
  write(p)
}

export function getTableFilter(): string {
  return read().tableFilter
}
export function setTableFilter(v: string) {
  write({ ...read(), tableFilter: v })
}

export function getShowSystem(): boolean {
  return read().showSystem
}
export function setShowSystem(v: boolean) {
  write({ ...read(), showSystem: v })
}
