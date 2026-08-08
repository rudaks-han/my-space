/**
 * 접속 하나를 다루는 데 필요한 어휘 — 두 화면(데이터베이스 뷰어, IntelliJ Cowork)이
 * 같은 것을 가리키도록 여기 모아 둔다.
 *
 * `DbConnection` 과 `resolveUrl` 은 엔진 카탈로그(`engines.ts`)에 붙어 있어야 하는
 * 값이라 그쪽에 그대로 두고 여기서 다시 내보낸다 — 두 번째 화면이 "접속에 필요한 것"을
 * 한 군데서 가져오게 하려는 것이지, 엔진 표를 쪼개려는 게 아니다.
 *
 * 나머지 둘은 원래 `db-viewer-view.tsx` 안에 숨어 있던 것들이다. 붙일 때마다 다시
 * 쓰게 되는데(테이블 목록에서 시스템 카탈로그를 걸러내기 · `db_connect` 인자 조립),
 * 복사해 두면 드라이버 클래스 규칙 같은 게 한쪽만 바뀌어 조용히 어긋난다.
 */

import * as db from "./db-client"
import type { ConnInfo, TableRef } from "./db-client"
import { engineById, resolveUrl, type DbConnection } from "./engines"

export { resolveUrl }
export type { DbConnection }

/** 시스템 카탈로그로 보이는 테이블인지(체크 해제 시 목록에서 감춘다). */
export function isSystemTable(t: TableRef) {
  if (/SYSTEM/i.test(t.type)) return true
  const s = (t.schema ?? t.catalog ?? "").toLowerCase()
  return (
    s === "information_schema" ||
    s === "performance_schema" ||
    s === "mysql" ||
    s === "sys" ||
    s.startsWith("pg_")
  )
}

/**
 * 저장된 접속 정보로 실제 연결을 연다.
 *
 * 드라이버 클래스를 **jar 를 직접 올린 경우에만** 넘기는 게 규칙이다. jar 가 없으면
 * 브리지가 클래스패스에서 ServiceLoader 로 찾게 두는 편이 낫고, 있으면 여러 jar 중
 * 엉뚱한 드라이버가 먼저 잡히는 걸 막아야 한다(`engines.ts` 머리말 참고).
 *
 * 비밀번호는 빈 문자열이면 `null` 로 보낸다 — 그래야 Rust 가 기기 암호화해 저장해 둔
 * 값을 쓴다(빈 문자열은 "비밀번호가 빈 계정"이라는 뜻이 돼 버린다).
 */
export function connectDb(
  conn: DbConnection,
  password: string
): Promise<ConnInfo> {
  const spec = engineById(conn.engine)
  return db.connect({
    connId: conn.id,
    url: resolveUrl(conn),
    user: conn.user.trim() || null,
    password: password || null,
    driverClass: conn.jars.length > 0 ? spec.driverClass : null,
    jars: conn.jars,
    savePassword: conn.savePassword,
  })
}
