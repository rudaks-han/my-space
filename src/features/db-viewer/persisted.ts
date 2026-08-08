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

/** 화면 하나가 들고 있는 테이블 목록 상태. */
interface ScopedPrefs {
  tableFilter: string
  showSystem: boolean
}

interface DbPersisted {
  /**
   * 키는 `<화면 접두사:><접속 id>:<카탈로그>.<스키마>.<테이블>` — **키를 만드는 쪽은
   * 호출자다**(`TablePane` 의 `scope` prop 이 그 접두사를 붙인다).
   *
   * ⚠️ 접두사가 없으면 화면 구분도 없다. 그러면 한쪽에서 탭을 닫을 때 도는
   * `purgeTableQuery` 가 다른 쪽 화면이 지금 쓰고 있는 WHERE·ORDER BY 까지 지운다.
   * 그래서 IntelliJ Cowork 은 `coworkDev:` 를 붙이고, 데이터베이스 뷰어는 저장된 값을
   * 잃지 않도록 접두사 없이 그대로 둔다.
   */
  queries: Record<string, TableQuery>
  /** 키는 `<화면 접두사:><접속 id>`. 콘솔에 써 둔 SQL(접두사 규칙은 `queries` 와 같다). */
  consoleSql: Record<string, string>
  /** 왼쪽 테이블 목록 검색어(화면 구분 없는 기본 칸 = 데이터베이스 뷰어). */
  tableFilter: string
  /** 시스템 테이블(INFORMATION_SCHEMA 등)을 목록에 넣을지(기본 칸). */
  showSystem: boolean
  /**
   * 화면(scope)별 목록 상태. 두 화면이 각자 다른 접속을 보고 있으므로 검색어와
   * 시스템 테이블 표시는 칸 하나를 나눠 쓰면 안 된다 — 한쪽에서 타이핑한 검색어가
   * 다른 쪽 목록을 비워 버린다.
   */
  scopes: Record<string, Partial<ScopedPrefs>>
}

const DEFAULTS: DbPersisted = {
  queries: {},
  consoleSql: {},
  tableFilter: "",
  showSystem: false,
  scopes: {},
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

/** 탭을 닫을 때 조회 조건을 버린다. 키에 화면 구분이 없다는 점은 `queries` 주석 참고. */
export function purgeTableQuery(key: string) {
  const p = read()
  delete p.queries[key]
  write(p)
}

/** `scope` 는 화면 접두사(뒤에 붙는 선택 인자 — 뷰어의 기존 저장 위치를 바꾸지 않는다). */
function consoleKey(connId: string, scope?: string): string {
  return scope ? `${scope}:${connId}` : connId
}

export function getConsoleSql(connId: string, scope?: string): string {
  return read().consoleSql[consoleKey(connId, scope)] ?? ""
}

export function setConsoleSql(connId: string, sql: string, scope?: string) {
  const p = read()
  p.consoleSql[consoleKey(connId, scope)] = sql
  write(p)
}

/**
 * 아래 네 함수의 `scope` 는 **뒤에 붙는 선택 인자**다 — 데이터베이스 뷰어의 기존 호출을
 * 한 글자도 바꾸지 않고(= 저장 위치도 그대로) 두 번째 화면만 자기 칸을 쓰게 하려는 것이다.
 */
export function getTableFilter(scope?: string): string {
  const p = read()
  return scope ? (p.scopes[scope]?.tableFilter ?? "") : p.tableFilter
}
export function setTableFilter(v: string, scope?: string) {
  write(
    patchScope(scope, { tableFilter: v }, (p) => ({ ...p, tableFilter: v }))
  )
}

export function getShowSystem(scope?: string): boolean {
  const p = read()
  return scope ? (p.scopes[scope]?.showSystem ?? false) : p.showSystem
}
export function setShowSystem(v: boolean, scope?: string) {
  write(patchScope(scope, { showSystem: v }, (p) => ({ ...p, showSystem: v })))
}

/** scope 가 있으면 그 칸을, 없으면 기본 칸을 고친 새 스냅샷을 만든다. */
function patchScope(
  scope: string | undefined,
  patch: Partial<ScopedPrefs>,
  plain: (p: DbPersisted) => DbPersisted
): DbPersisted {
  const p = read()
  if (!scope) return plain(p)
  // DEFAULTS.scopes 를 그대로 물고 오는 경우가 있어 새 객체로 갈아 끼운다.
  return {
    ...p,
    scopes: { ...p.scopes, [scope]: { ...p.scopes[scope], ...patch } },
  }
}
