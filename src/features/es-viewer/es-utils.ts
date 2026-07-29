/** ES 뷰어 공용 유틸 — 포맷팅, 필드 타입 판정, 매핑 해석 등 순수 함수 모음. */

/** 필드 타입 정보 { name: { type, hasKeyword } }. */
export interface FieldInfo {
  type: string
  hasKeyword: boolean
}
export type FieldInfoMap = Record<string, FieldInfo>

/** 정렬 가능한 필드 타입. */
const SORTABLE_TYPES = new Set([
  "keyword",
  "long",
  "integer",
  "short",
  "byte",
  "double",
  "float",
  "half_float",
  "scaled_float",
  "date",
  "date_nanos",
  "boolean",
  "ip",
  "version",
  "wildcard",
])

/** Query DSL 자동완성용 ES 키워드. */
export const DSL_KEYWORDS = [
  "query",
  "bool",
  "must",
  "should",
  "must_not",
  "filter",
  "match",
  "match_phrase",
  "match_phrase_prefix",
  "multi_match",
  "match_all",
  "term",
  "terms",
  "range",
  "exists",
  "prefix",
  "wildcard",
  "regexp",
  "fuzzy",
  "ids",
  "query_string",
  "simple_query_string",
  "nested",
  "gte",
  "lte",
  "gt",
  "lt",
  "boost",
  "from",
  "size",
  "sort",
  "order",
  "field",
  "fields",
  "value",
  "values",
  "operator",
  "minimum_should_match",
  "analyzer",
  "format",
  "slop",
  "fuzziness",
]

/** `_mapping` 응답에서 필드 타입 맵을 뽑는다. */
export function extractFieldInfo(
  index: string,
  res: Record<string, unknown>
): FieldInfoMap {
  const body = (res[index] ?? Object.values(res)[0] ?? {}) as {
    mappings?: { properties?: Record<string, unknown> }
  }
  const props = body.mappings?.properties ?? {}
  const info: FieldInfoMap = {}
  for (const name of Object.keys(props)) {
    const spec = props[name] as {
      type?: string
      properties?: unknown
      fields?: { keyword?: unknown }
    }
    const type = spec.type || (spec.properties ? "object" : "object")
    const hasKeyword = !!spec.fields?.keyword
    info[name] = { type, hasKeyword }
  }
  return info
}

/** 필드가 정렬 가능한지 (매핑 정보 없으면 허용). */
export function isSortable(name: string, fieldInfo: FieldInfoMap): boolean {
  const info = fieldInfo[name]
  if (!info) return true
  if (SORTABLE_TYPES.has(info.type)) return true
  if (info.type === "text" && info.hasKeyword) return true
  return false
}

/** ES 정렬 실패가 "정렬 불가 필드" 때문인지(그러면 .keyword 로 재시도). */
export function isSortFieldError(detail: string): boolean {
  const d = detail.toLowerCase()
  return (
    d.includes("fielddata") ||
    d.includes("illegal_argument") ||
    d.includes("text field") ||
    d.includes("not indexed")
  )
}

/** 스칼라(중첩 아님) 필드인지. */
export function isScalarField(
  name: string,
  fieldInfo: FieldInfoMap,
  firstHit?: Record<string, unknown>
): boolean {
  const info = fieldInfo[name]
  if (info) return info.type !== "object" && info.type !== "nested"
  const v = firstHit?.[name]
  return v === null || v === undefined || typeof v !== "object"
}

/**
 * 컬럼 선택·정렬 대상이 되는 전체 필드 목록.
 * 매핑을 얻었으면 그 필드들을, 못 얻었으면 현재 결과의 `_source` 키를 쓴다.
 */
export function effectiveFields(
  masterFields: string[],
  hits: { _source?: Record<string, unknown> }[]
): string[] {
  if (masterFields.length) return masterFields
  const set = new Set<string>()
  for (const h of hits) {
    for (const k of Object.keys(h._source ?? {})) set.add(k)
  }
  return [...set].sort()
}

/** 기본 표시 컬럼 — 스칼라(중첩 아님) 필드 위주로 최대 10개. */
export function defaultColumns(
  masterFields: string[],
  fieldInfo: FieldInfoMap,
  hits: { _source?: Record<string, unknown> }[]
): string[] {
  return effectiveFields(masterFields, hits)
    .filter((f) => isScalarField(f, fieldInfo, hits[0]?._source))
    .slice(0, 10)
}

/** 숫자를 한국어 천단위 구분으로. */
export function fmtNum(n: unknown): string {
  const num = parseInt(String(n), 10)
  if (isNaN(num)) return String(n ?? "0")
  return num.toLocaleString("ko-KR")
}

/** 바이트 수(문자열)를 사람이 읽는 크기로. */
export function fmtBytes(v: unknown): string {
  let bytes = parseInt(String(v), 10)
  if (isNaN(bytes)) return String(v ?? "-")
  const units = ["B", "KB", "MB", "GB", "TB"]
  let i = 0
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024
    i++
  }
  return `${bytes.toFixed(i === 0 ? 0 : 1)}${units[i]}`
}

/** 셀 값의 툴팁용 평문. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

/**
 * ~At / ~Date / ~Time 로 끝나는 필드의 epoch 값을 사람이 읽는 날짜로.
 * 날짜로 볼 수 없으면 null.
 */
export function asEpochDate(key: string, v: unknown): string | null {
  if (!key || !/(at|date|time)$/i.test(key)) return null
  let n =
    typeof v === "number"
      ? v
      : typeof v === "string" && /^\d+$/.test(v)
        ? Number(v)
        : NaN
  if (!Number.isFinite(n) || n <= 0) return null
  if (n >= 1e12) {
    // 밀리초
  } else if (n >= 1e9) {
    n = n * 1000 // 초 → 밀리초
  } else {
    return null
  }
  try {
    return new Date(n).toLocaleString("ko-KR")
  } catch {
    return null
  }
}
