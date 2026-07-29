import { trackedInvoke } from "@/lib/tauri"

/**
 * ES 연결 정보. 프론트엔드(localStorage)에 저장했다가 요청마다 Rust 로 넘긴다.
 * 브라우저에서 임의 호스트로 직접 fetch 하면 CORS 에 막히므로, 실제 HTTP 는
 * Rust(`es_request`)가 대신 보낸다.
 */
export interface EsConnection {
  host: string
  /** 비우면(null) 포트 없이 접속. */
  port: number | null
  https: boolean
  username: string
  password: string
}

/** Rust `es_request` 가 돌려주는 봉투. */
interface EsResponse {
  ok: boolean
  status: number
  body: unknown
}

/** ES/네트워크 오류. status=0 이면 네트워크 계층 실패. */
export class EsError extends Error {
  status: number
  detail: string
  raw: unknown

  constructor(message: string, status: number, detail: string, raw?: unknown) {
    super(message)
    this.name = "EsError"
    this.status = status
    this.detail = detail
    this.raw = raw
  }
}

/** ES `_cat/indices` 한 행. */
export interface IndexRow {
  index: string
  health?: string
  "docs.count"?: string
  "store.size"?: string
  [key: string]: unknown
}

/** 검색 결과 문서 하나. */
export interface Hit {
  _index: string
  _id: string
  _score: number | null
  _source: Record<string, unknown>
}

export interface SearchResult {
  hits: Hit[]
  total: number
}

export interface SearchOptions {
  /** 간편 검색(query_string). */
  query?: string
  /** Query DSL 쿼리 객체(있으면 query 대신 사용). */
  dsl?: unknown
  from?: number
  size?: number
  sort?: unknown
}

/**
 * ES REST 래퍼. 크롬 확장의 `ESClient` 를 그대로 옮긴 것으로, 모든 동작이
 * Rust 프록시 명령(`es_request`) 하나 위에 구성된다.
 */
export class EsClient {
  private conn: EsConnection

  constructor(conn: EsConnection) {
    this.conn = conn
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    let res: EsResponse
    try {
      res = await trackedInvoke<EsResponse>("es_request", {
        config: {
          host: this.conn.host.trim(),
          port: this.conn.port || null,
          https: this.conn.https,
          username: this.conn.username?.trim() || null,
          password: this.conn.password || null,
        },
        method,
        path,
        body: body ?? null,
      })
    } catch (e) {
      // Rust 에서 네트워크 계층 실패는 문자열 에러로 던져진다.
      throw new EsError(String(e), 0, String(e))
    }

    if (!res.ok) {
      const body = res.body as { error?: unknown } | string | null
      const err =
        body && typeof body === "object" ? (body.error as unknown) : null
      let reason: string
      if (err && typeof err === "object") {
        const e = err as {
          root_cause?: { reason?: string }[]
          reason?: string
          type?: string
        }
        // 근본 원인(root_cause)이 가장 구체적 — fielddata 등 상세 메시지가 담긴다.
        reason =
          e.root_cause?.[0]?.reason ||
          e.reason ||
          e.type ||
          `HTTP ${res.status}`
      } else {
        reason = typeof body === "string" ? body : `HTTP ${res.status}`
      }
      throw new EsError(
        `요청 실패 (${res.status})`,
        res.status,
        reason,
        res.body
      )
    }

    return res.body as T
  }

  /** 클러스터 기본 정보 (GET /) */
  info() {
    return this.request<{
      cluster_name?: string
      version?: { number?: string }
    }>("GET", "/")
  }

  /** 인덱스 목록 (GET /_cat/indices) */
  async indices(): Promise<IndexRow[]> {
    const data = await this.request<unknown>(
      "GET",
      "/_cat/indices?format=json&bytes=b&s=index:asc"
    )
    return Array.isArray(data) ? (data as IndexRow[]) : []
  }

  /** 매핑 조회 (필드 목록 확보용) */
  mapping(index: string) {
    return this.request<Record<string, unknown>>(
      "GET",
      `/${encodeURIComponent(index)}/_mapping`
    )
  }

  /** 인덱스 설정 조회 */
  settings(index: string) {
    return this.request<Record<string, unknown>>(
      "GET",
      `/${encodeURIComponent(index)}/_settings`
    )
  }

  /** 문서 검색 */
  search(
    index: string,
    { query, dsl = null, from = 0, size = 25, sort = null }: SearchOptions = {}
  ) {
    let q: unknown
    if (dsl && typeof dsl === "object") {
      q = dsl
    } else if (query && query.trim() && query.trim() !== "*") {
      q = { query_string: { query: query.trim() } }
    } else {
      q = { match_all: {} }
    }
    const body: Record<string, unknown> = {
      query: q,
      from,
      size,
      track_total_hits: true,
    }
    if (sort) body.sort = sort
    return this.request<{
      hits?: { hits?: Hit[]; total?: number | { value: number } }
    }>("POST", `/${encodeURIComponent(index)}/_search`, body)
  }

  /** 문서 수정 (PUT /{index}/_doc/{id}) — _source 전체 교체 */
  updateDoc(index: string, id: string, source: unknown) {
    return this.request(
      "PUT",
      `/${encodeURIComponent(index)}/_doc/${encodeURIComponent(id)}?refresh=true`,
      source
    )
  }

  /** 인덱스 삭제 (DELETE /{index}) — 되돌릴 수 없음 */
  deleteIndex(index: string) {
    return this.request("DELETE", `/${encodeURIComponent(index)}`)
  }

  /** 선택한 문서들 삭제 (_delete_by_query, _id 기준) — 되돌릴 수 없음 */
  deleteByIds(index: string, ids: string[]) {
    return this.request<{ deleted?: number }>(
      "POST",
      `/${encodeURIComponent(index)}/_delete_by_query?refresh=true&conflicts=proceed`,
      { query: { ids: { values: ids } } }
    )
  }
}
