import { trackedInvoke } from "@/lib/tauri"

/**
 * 데이터베이스 뷰어의 프론트엔드 클라이언트.
 *
 * 실제 DB 통신은 Rust(`src-tauri/src/db.rs`)가 띄운 JDBC 사이드카가 한다. 여기서는
 * 명령 호출과 타입만 담당한다(ES·Kafka 뷰어의 클라이언트와 같은 구조).
 *
 * ⚠️ 셀 값은 전부 `string | null` 이다. 숫자로 받으면 BIGINT·DECIMAL 이 자바스크립트의
 *    double 정밀도에서 조용히 바뀐다(9007199254740993 → …992). `null` 은 SQL NULL 이고
 *    빈 문자열과 구분된다 — 그리드도 이 구분을 그대로 보여 준다.
 */

/* ─────────────────────────── 타입 ─────────────────────────── */

export interface BridgeInfo {
  javaPath: string | null
  javaVersion: string | null
  ok: boolean
  error: string | null
}

export interface DriverJar {
  path: string
  name: string
  version: string
  /** "maven" | "gradle" */
  source: string
}

export interface ConnInfo {
  product: string
  productVersion: string
  driverName: string
  driverVersion: string
  /** 식별자 인용 부호. */
  quote: string
  autoCommit: boolean
  catalog: string | null
  schema: string | null
  readOnly: boolean
}

export interface SchemaRef {
  catalog: string | null
  schema: string | null
  /** 표시용 이름. */
  label: string
}

export interface SchemasResult {
  schemas: SchemaRef[]
  current: { catalog: string | null; schema: string | null }
}

export interface TableRef {
  catalog: string | null
  schema: string | null
  name: string
  /** "TABLE" | "VIEW" | "BASE TABLE" | "SYSTEM TABLE" … 드라이버마다 표기가 다르다. */
  type: string
  remarks: string | null
}

export interface ColumnMeta {
  name: string
  typeName: string
  jdbcType: number
  size: number
  digits: number | null
  nullable: boolean
  defaultValue: string | null
  remarks: string | null
  position: number
  autoIncrement: boolean
  generated: boolean
}

export interface IndexMeta {
  name: string
  unique: boolean
  columns: string[]
}

export interface ForeignKeyMeta {
  name: string
  column: string
  refSchema: string | null
  refTable: string
  refColumn: string
}

export interface TableMeta {
  columns: ColumnMeta[]
  primaryKey: string[]
  indexes: IndexMeta[]
  foreignKeys: ForeignKeyMeta[]
  /** 인용까지 끝난 `스키마.테이블`. 쿼리 콘솔의 "이름 넣기"에 쓴다. */
  qualifiedName: string
}

export interface ResultColumn {
  name: string
  typeName: string
  jdbcType: number
  table: string | null
  /** BLOB·BINARY 계열. 값은 16진수 미리보기라 편집할 수 없다. */
  binary: boolean
}

/** 셀 하나. `null` 은 SQL NULL. */
export type Cell = string | null

export interface RowsResult {
  kind: "rows"
  columns: ResultColumn[]
  rows: Cell[][]
  /** limit 에 걸려 잘렸는지. */
  truncated: boolean
  elapsedMs?: number
  offset?: number
  autoCommit?: boolean
}

export interface UpdateResult {
  kind: "update"
  updateCount: number
}

export type QueryResult = RowsResult | UpdateResult

export interface QueryResponse {
  results: QueryResult[]
  elapsedMs: number
  warnings: string[]
  autoCommit: boolean
}

/** 보류 중인 편집 하나. `values`/`keys` 의 값은 셀과 같은 `string | null`. */
export interface Change {
  op: "insert" | "update" | "delete"
  catalog: string | null
  schema: string | null
  table: string
  keys?: Record<string, Cell>
  values?: Record<string, Cell>
}

export interface ApplyResult {
  applied: number
  /** 수동 커밋 모드라 아직 커밋되지 않았는지. */
  pendingTx: boolean
}

/** Rust 가 문자열로 던진 오류를 감싼다. */
export class DbError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DbError"
  }
}

async function call<T>(cmd: string, args: Record<string, unknown> = {}) {
  try {
    return await trackedInvoke<T>(cmd, args)
  } catch (e) {
    throw new DbError(String(e))
  }
}

/* ─────────────────────────── 브리지 · 드라이버 ─────────────────────────── */

export function bridgeInfo() {
  return call<BridgeInfo>("db_bridge_info")
}

export function restartBridge() {
  return call<void>("db_restart_bridge")
}

/** 로컬 메이븐/그레이들 캐시에서 이 엔진용 드라이버 jar 를 찾는다(최신 버전이 앞). */
export function findDrivers(engine: string) {
  return call<DriverJar[]>("db_find_drivers", { engine })
}

/* ─────────────────────────── 접속 ─────────────────────────── */

export interface ConnectArgs {
  connId: string
  url: string
  user: string | null
  /** 비우면 저장된 비밀번호를 쓴다. */
  password: string | null
  driverClass: string | null
  jars: string[]
  savePassword: boolean
}

export function connect(args: ConnectArgs) {
  return call<ConnInfo>("db_connect", { req: args })
}

/**
 * 접속 해제. 남은 접속이 없으면 Rust 가 JDBC 브리지(JVM)까지 내린다 —
 * 다음 연결이 다시 띄우므로 첫 요청에 1~2초가 더 걸린다.
 */
export function disconnect(connId: string) {
  return call<{ closed: boolean; remaining: number }>("db_disconnect", {
    connId,
  })
}

export function hasSavedPassword(connId: string) {
  return call<boolean>("db_has_password", { connId })
}

export function forgetPassword(connId: string) {
  return call<void>("db_forget_password", { connId })
}

/* ─────────────────────────── 메타데이터 ─────────────────────────── */

export function schemas(connId: string) {
  return call<SchemasResult>("db_schemas", { connId })
}

export function tables(
  connId: string,
  catalog: string | null,
  schema: string | null
) {
  return call<{ tables: TableRef[] }>("db_tables", { connId, catalog, schema })
}

export function tableMeta(
  connId: string,
  catalog: string | null,
  schema: string | null,
  table: string
) {
  return call<TableMeta>("db_table_meta", { connId, catalog, schema, table })
}

/* ─────────────────────────── 조회 ─────────────────────────── */

export function query(
  connId: string,
  sql: string,
  limit: number,
  token: string | null = null
) {
  return call<QueryResponse>("db_query", { connId, sql, limit, token })
}

export interface TableRowsArgs {
  connId: string
  catalog: string | null
  schema: string | null
  table: string
  limit: number
  offset: number
  orderBy: string | null
  whereClause: string | null
  token: string | null
}

export function tableRows(args: TableRowsArgs) {
  return call<RowsResult>("db_table_rows", { ...args })
}

export function count(
  connId: string,
  catalog: string | null,
  schema: string | null,
  table: string,
  whereClause: string | null
) {
  return call<{ count: number }>("db_count", {
    connId,
    catalog,
    schema,
    table,
    whereClause,
  })
}

/** 실행 중인 쿼리를 끊는다. `token` 은 query/tableRows 에 넘긴 값과 같아야 한다. */
export function cancel(connId: string, token: string) {
  return call<{ cancelled: boolean; reason?: string }>("db_cancel", {
    connId,
    token,
  })
}

/* ─────────────────────────── 수정 · 트랜잭션 ─────────────────────────── */

export function applyChanges(connId: string, changes: Change[]) {
  return call<ApplyResult>("db_apply_changes", { connId, changes })
}

export function setAutoCommit(connId: string, on: boolean) {
  return call<{ autoCommit: boolean }>("db_set_auto_commit", { connId, on })
}

export function commit(connId: string) {
  return call<{ committed: boolean; reason?: string }>("db_commit", { connId })
}

export function rollback(connId: string) {
  return call<{ rolledBack: boolean; reason?: string }>("db_rollback", {
    connId,
  })
}
