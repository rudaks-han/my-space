/**
 * ES 뷰어의 인덱스별/전역 설정을 localStorage 에 직접 읽고 쓰는 모듈.
 *
 * 검색어·DSL·컬럼·정렬처럼 "타이핑할 때마다 저장"되는 값은 React state 로 올리면
 * 매 키 입력마다 전체 뷰(및 keep-alive 된 모든 탭)가 리렌더된다. 이를 피하려고
 * 크롬 확장처럼 localStorage 를 직접 다룬다. 탭 목록/활성 탭/연결 정보처럼 렌더에
 * 직접 쓰이는 값만 뷰에서 useLocalStorage 로 관리한다.
 */

const KEY = "myspace.esViewer"

export type SearchMode = "simple" | "dsl"
export interface SortSpec {
  field: string
  order: "asc" | "desc"
}

interface EsPersisted {
  queries: Record<string, string>
  dslQueries: Record<string, string>
  columns: Record<string, string[]>
  sorts: Record<string, SortSpec>
  searchMode: SearchMode
  pageSize: number
  indexFilter: string
}

const DEFAULTS: EsPersisted = {
  queries: {},
  dslQueries: {},
  columns: {},
  sorts: {},
  searchMode: "simple",
  pageSize: 25,
  indexFilter: "",
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

/* ── 인덱스별 간편 검색어 ── */
export function getIndexQuery(index: string): string {
  return read().queries[index] ?? ""
}
export function setIndexQuery(index: string, q: string) {
  const p = read()
  p.queries[index] = q
  write(p)
}

/* ── 인덱스별 Query DSL 텍스트 ── */
export function getIndexDsl(index: string): string {
  return read().dslQueries[index] ?? ""
}
export function setIndexDsl(index: string, text: string) {
  const p = read()
  p.dslQueries[index] = text
  write(p)
}

/* ── 인덱스별 표시 컬럼 (없으면 null = 기본값 사용) ── */
export function getIndexColumns(index: string): string[] | null {
  return read().columns[index] ?? null
}
export function setIndexColumns(index: string, cols: string[]) {
  const p = read()
  p.columns[index] = cols
  write(p)
}
export function clearIndexColumns(index: string) {
  const p = read()
  delete p.columns[index]
  write(p)
}

/* ── 인덱스별 정렬 조건 (없으면 null) ── */
export function getIndexSort(index: string): SortSpec | null {
  return read().sorts[index] ?? null
}
export function setIndexSort(index: string, sort: SortSpec | null) {
  const p = read()
  if (sort) p.sorts[index] = sort
  else delete p.sorts[index]
  write(p)
}

/* ── 전역: 검색 모드 / 페이지 크기 / 인덱스 필터 ── */
export function getSearchMode(): SearchMode {
  return read().searchMode
}
export function setSearchMode(m: SearchMode) {
  write({ ...read(), searchMode: m })
}
export function getPageSize(): number {
  return read().pageSize
}
export function setPageSize(n: number) {
  write({ ...read(), pageSize: n })
}
export function getIndexFilter(): string {
  return read().indexFilter
}
export function setIndexFilter(v: string) {
  write({ ...read(), indexFilter: v })
}

/** 인덱스 삭제 시 그 인덱스의 모든 저장 상태를 정리한다. */
export function purgeIndex(index: string) {
  const p = read()
  delete p.queries[index]
  delete p.dslQueries[index]
  delete p.columns[index]
  delete p.sorts[index]
  write(p)
}
