/**
 * ES 뷰어의 인덱스별/전역 설정을 localStorage 에 직접 읽고 쓰는 모듈.
 *
 * 검색어·DSL·컬럼·정렬처럼 "타이핑할 때마다 저장"되는 값은 React state 로 올리면
 * 매 키 입력마다 전체 뷰(및 keep-alive 된 모든 탭)가 리렌더된다. 이를 피하려고
 * 크롬 확장처럼 localStorage 를 직접 다룬다. 탭 목록/활성 탭/연결 정보처럼 렌더에
 * 직접 쓰이는 값만 뷰에서 useLocalStorage 로 관리한다.
 *
 * ── 화면(scope) 구분 ──
 * 모든 get/set 의 **마지막 인자**로 붙는 `scope` 는 저장 칸의 화면 접두사다. 안 주면
 * Elasticsearch 뷰어가 예전부터 쓰던 칸을 그대로 읽고 쓴다 — 뷰어의 기존 호출을 한 글자도
 * 바꾸지 않고(= 저장된 값도 그대로) 두 번째 화면만 자기 칸을 쓰게 하려는 배치다.
 * 데이터베이스 뷰어의 `persisted.ts` 와 같은 모양이고, 이유도 같다: 접두사가 없으면
 * 화면 구분도 없어서 한쪽의 `purgeIndex` 가 다른 쪽이 지금 쓰는 검색어를 지우고,
 * 무엇보다 페이지 크기처럼 **패널 mount 때 한 번만 읽는 값**은 부딪혀도 깜빡이지 않고
 * 몇 분 뒤에야 "왜 100건씩 나오지" 로 조용히 드러난다.
 */

const KEY = "myspace.esViewer"

export type SearchMode = "simple" | "dsl"
export interface SortSpec {
  field: string
  order: "asc" | "desc"
}

/** 화면 하나가 들고 있는 전역 상태(인덱스별이 아니라 화면별로 하나씩). */
interface ScopedPrefs {
  searchMode: SearchMode
  pageSize: number
  indexFilter: string
}

interface EsPersisted {
  /**
   * 아래 네 맵의 키는 `<화면 접두사:><인덱스 이름>` — **키를 만드는 쪽은 호출자**가 아니라
   * 이 모듈의 `slot()` 이고, 접두사는 `IndexPane` 의 `scope` prop 에서 온다.
   * 접두사가 없는 키가 곧 Elasticsearch 뷰어의 몫이다.
   */
  queries: Record<string, string>
  dslQueries: Record<string, string>
  columns: Record<string, string[]>
  sorts: Record<string, SortSpec>
  /** 검색 모드(화면 구분 없는 기본 칸 = Elasticsearch 뷰어). */
  searchMode: SearchMode
  /** 한 페이지 건수(기본 칸). */
  pageSize: number
  /** 왼쪽 인덱스 목록 검색어(기본 칸). */
  indexFilter: string
  /**
   * 화면(scope)별 전역 상태. 이 셋은 칸이 인덱스마다 있는 게 아니라 하나뿐이고
   * **패널이 mount 될 때 한 번만 읽힌다** — 그래서 두 화면이 나눠 쓰면 화면이 깜빡이는
   * 대신, 한쪽에서 바꾼 페이지 크기를 다른 쪽이 다음에 여는 탭에서 조용히 물려받는다.
   */
  scopes: Record<string, Partial<ScopedPrefs>>
}

const DEFAULTS: EsPersisted = {
  queries: {},
  dslQueries: {},
  columns: {},
  sorts: {},
  searchMode: "simple",
  pageSize: 25,
  indexFilter: "",
  scopes: {},
}

function read(): EsPersisted {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<EsPersisted>) }
  } catch {
    return { ...DEFAULTS }
  }
}

function write(p: EsPersisted) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    // 저장 실패는 무시(용량 초과 등)
  }
}

/**
 * 인덱스별 칸의 키. `scope` 가 없으면 인덱스 이름 그대로 — 뷰어가 예전에 저장한 칸이다.
 * 인덱스 이름에는 `:` 를 쓸 수 없어서 접두사와 섞일 걱정이 없다.
 */
function slot(index: string, scope?: string): string {
  return scope ? `${scope}:${index}` : index
}

/* ── 인덱스별 간편 검색어 ── */
export function getIndexQuery(index: string, scope?: string): string {
  return read().queries[slot(index, scope)] ?? ""
}
export function setIndexQuery(index: string, q: string, scope?: string) {
  const p = read()
  p.queries[slot(index, scope)] = q
  write(p)
}

/* ── 인덱스별 Query DSL 텍스트 ── */
export function getIndexDsl(index: string, scope?: string): string {
  return read().dslQueries[slot(index, scope)] ?? ""
}
export function setIndexDsl(index: string, text: string, scope?: string) {
  const p = read()
  p.dslQueries[slot(index, scope)] = text
  write(p)
}

/* ── 인덱스별 표시 컬럼 (없으면 null = 기본값 사용) ── */
export function getIndexColumns(
  index: string,
  scope?: string
): string[] | null {
  return read().columns[slot(index, scope)] ?? null
}
export function setIndexColumns(index: string, cols: string[], scope?: string) {
  const p = read()
  p.columns[slot(index, scope)] = cols
  write(p)
}
export function clearIndexColumns(index: string, scope?: string) {
  const p = read()
  delete p.columns[slot(index, scope)]
  write(p)
}

/* ── 인덱스별 정렬 조건 (없으면 null) ── */
export function getIndexSort(index: string, scope?: string): SortSpec | null {
  return read().sorts[slot(index, scope)] ?? null
}
export function setIndexSort(
  index: string,
  sort: SortSpec | null,
  scope?: string
) {
  const p = read()
  if (sort) p.sorts[slot(index, scope)] = sort
  else delete p.sorts[slot(index, scope)]
  write(p)
}

/* ── 전역: 검색 모드 / 페이지 크기 / 인덱스 필터 ── */
export function getSearchMode(scope?: string): SearchMode {
  const p = read()
  return scope
    ? (p.scopes[scope]?.searchMode ?? DEFAULTS.searchMode)
    : p.searchMode
}
export function setSearchMode(m: SearchMode, scope?: string) {
  write(patchScope(scope, { searchMode: m }, (p) => ({ ...p, searchMode: m })))
}

export function getPageSize(scope?: string): number {
  const p = read()
  return scope ? (p.scopes[scope]?.pageSize ?? DEFAULTS.pageSize) : p.pageSize
}
export function setPageSize(n: number, scope?: string) {
  write(patchScope(scope, { pageSize: n }, (p) => ({ ...p, pageSize: n })))
}

export function getIndexFilter(scope?: string): string {
  const p = read()
  return scope ? (p.scopes[scope]?.indexFilter ?? "") : p.indexFilter
}
export function setIndexFilter(v: string, scope?: string) {
  write(
    patchScope(scope, { indexFilter: v }, (p) => ({ ...p, indexFilter: v }))
  )
}

/**
 * 인덱스 삭제 시 그 인덱스의 모든 저장 상태를 정리한다.
 *
 * `scope` 를 받는 이유: 지우는 대상이 **자기 화면의 칸이어야** 한다. 인덱스를 실제로
 * 지웠다면 다른 화면의 칸도 결국 의미가 없어지지만, 그쪽 패널은 아직 열려 있고 그 상태를
 * 들고 있어서(mount 때 읽고 이후엔 자기 state) 남겨 둬도 해가 없다. 반대로 남의 칸까지
 * 지우면 아직 화면에 떠 있는 조회 조건을 밑에서 빼앗는 셈이 된다.
 */
export function purgeIndex(index: string, scope?: string) {
  const p = read()
  const k = slot(index, scope)
  delete p.queries[k]
  delete p.dslQueries[k]
  delete p.columns[k]
  delete p.sorts[k]
  write(p)
}

/** scope 가 있으면 그 칸을, 없으면 기본 칸을 고친 새 스냅샷을 만든다. */
function patchScope(
  scope: string | undefined,
  patch: Partial<ScopedPrefs>,
  plain: (p: EsPersisted) => EsPersisted
): EsPersisted {
  const p = read()
  if (!scope) return plain(p)
  // DEFAULTS.scopes 를 그대로 물고 오는 경우가 있어 새 객체로 갈아 끼운다.
  return {
    ...p,
    scopes: { ...p.scopes, [scope]: { ...p.scopes[scope], ...patch } },
  }
}
