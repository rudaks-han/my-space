import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { connectDb, type DbConnection } from "@/features/db-viewer/connection"
import * as db from "@/features/db-viewer/db-client"
import {
  announceDisconnect,
  onDisconnected,
} from "@/features/db-viewer/disconnect-bus"
import { engineById } from "@/features/db-viewer/engines"

/**
 * IntelliJ Cowork 화면의 데이터베이스 세션 — 연결 · 스키마 · 테이블 목록 · 트랜잭션을
 * 한 훅이 통째로 들고 있다.
 *
 * 이 흐름은 원래 `db-viewer-view.tsx` 안에 인라인으로 있던 것이다. 두 번째 화면이
 * 같은 순서(연결 → `db_schemas` → 스키마 고르기 → `db_tables`)를 다시 필요로 하는데,
 * 복사해 두면 드라이버 클래스 규칙이나 스키마 선택 규칙이 한쪽만 바뀌어 조용히 어긋난다.
 *
 * 반드시 알아야 할 네 가지:
 *
 * **(a) `connId` 는 자바 브리지 접속 맵의 키이고, 화면 사이에 공유된다.**
 * `db_disconnect(connId)` 는 그 접속을 **모든 화면에서** 닫고, 남은 접속이 0 이면
 * Rust 가 JVM 까지 내려서 다음 연결에 1~2초가 더 든다. 그런데도 접미사를 붙인
 * 별도 id 를 쓰지 않는다 — 그러면 세션은 독립되지만 **저장된 비밀번호를 잃는다**
 * (비밀번호는 정확히 이 id 로 `~/.myspace/db-secrets.json` 에 묶여 있다). 대신
 * 해제는 **사용자가 명시적으로 누를 때만** 한다: 언마운트·접속 전환·탭 닫기 어디서도
 * 자동으로 끊지 않는다(끊으면 옆 화면의 격자가 다음 조회에서 죽는다).
 *
 * **(a′) 같은 이유로 "붙여 달라"는 요청은 재연결이 아니라 `db_conn_info` 로 시작한다.**
 * 자바 브리지의 `opConnect` 는 같은 id 로 다시 들어오면 앞의 `java.sql.Connection` 을
 * **먼저 닫는다**. 데이터베이스 뷰어에서 수동 커밋으로 편집하던 중에 이 화면의 연결
 * 버튼을 누르면 그 트랜잭션이 통째로 롤백되고, 저쪽 화면은 자기 `info`·`autoCommit` 을
 * 그대로 들고 있어 "롤백할 수 있다"고 계속 약속한다. 그래서 비밀번호를 **직접 입력하지
 * 않은** 연결(패널의 연결 버튼 · 자동 연결)은 살아 있는 접속을 그대로 물려받는다.
 * 접속 관리 폼에서 비밀번호를 넘겨 부르는 경우만 진짜 재연결이다(주소·계정을 고쳐
 * 다시 붙이려는 흐름이라 앞의 접속을 닫는 게 맞다).
 *
 * **(b) `autoCommit` 은 패널이 아니라 JDBC 접속의 속성이다.** 그래서 이 훅이 유일한
 * 주인이고, 테이블 격자든 SQL 콘솔이든 전부 여기서 읽어 간다. 패널마다 따로 들면
 * 한 패널이 끈 수동 커밋 모드를 다른 패널이 켜진 걸로 알고 커밋 버튼을 감춘다.
 * **다만 "접속 하나"가 아니라 접속 id → 세션의 표다.** 가운데 탭에는 서로 다른 접속의
 * 격자와 콘솔이 동시에 열려 있을 수 있는데(오른쪽 패널에서 접속을 바꿔도 열린 탭은
 * 그대로 산다), 세션을 하나만 들면 그 탭들이 전부 "지금 고른 접속"의 커밋 모드를
 * 보게 된다 — 수동 커밋인 접속의 격자가 커밋 경고 없이 편집되고, 그 반대도 된다.
 *
 * **(c) 자동 연결은 마운트당 최대 한 번이고, 비밀번호가 이미 저장돼 있거나 애초에
 * 필요 없을 때만 한다.** 비밀번호를 물어야 하는 접속을 자동으로 시도하면 화면을 열
 * 때마다 인증 실패 오류만 뜨므로 그런 접속은 사용자가 직접 누르게 둔다.
 */

/** 스키마 선택 값 — 카탈로그·스키마 쌍을 문자열 하나로 접는다(둘 다 null 일 수 있다). */
export function schemaKeyOf(s: db.SchemaRef): string {
  return `${s.catalog ?? ""}.${s.schema ?? ""}`
}

/** 살아 있는 JDBC 세션 하나. 표(`Record<connId, Live>`)의 값이다. */
interface Live {
  info: db.ConnInfo
  schemas: db.SchemaRef[]
  schemaKey: string
  tables: db.TableRef[]
  autoCommit: boolean
  txDirty: boolean
}

export interface DbSession {
  /** 지금 고른 접속이 연결돼 있으면 접속 정보, 아니면 `null`. */
  info: db.ConnInfo | null
  connecting: boolean
  /**
   * 마지막 실패 메시지. `DbError` 의 본문은 JDBC 가 뱉은 **여러 줄짜리 원문**이라
   * 표시하는 쪽은 반드시 `whitespace-pre-wrap` 을 걸어야 한다.
   */
  connError: string | null

  schemas: db.SchemaRef[]
  schemaKey: string | null
  /** 스키마를 고르면 그 스키마의 테이블 목록을 곧바로 다시 읽는다. */
  setSchemaKey: (key: string) => void
  currentSchema: { catalog: string | null; schema: string | null } | null

  tables: db.TableRef[]
  loadingTables: boolean

  /**
   * 비우면 **살아 있는 접속을 그대로 물려받고**, 없을 때만 새로 붙인다((a′) 참고).
   * 비밀번호를 주면 언제나 진짜 재연결이다(빈 문자열도 "폼에서 눌렀다"는 뜻이므로
   * 재연결이고, 저장된 비밀번호를 쓰라는 신호는 Rust 쪽에서 처리한다).
   */
  connect: (password?: string) => Promise<void>
  disconnect: () => Promise<void>
  reloadTables: () => Promise<void>

  /** 지금 고른 접속의 자동 커밋 상태. */
  autoCommit: boolean
  /** 지금 고른 접속의 커밋되지 않은 변경 여부. */
  txDirty: boolean
  /** **탭이 물어볼 때는 반드시 이쪽이다** — 탭의 접속은 지금 고른 접속과 다를 수 있다. */
  autoCommitFor: (connId: string) => boolean
  txDirtyFor: (connId: string) => boolean
  /**
   * 그 접속에 **이 화면의 세션이 있는지.** 툴바가 커밋·롤백을 내보일지 정한다 —
   * 세션이 없으면 자동 커밋 값 자체가 추측(기본값 `true`)이라, 그 상태로 커밋 버튼을
   * 그리면 있지도 않은 트랜잭션을 커밋하라고 시키는 셈이다.
   */
  hasSession: (connId: string) => boolean
  /** 격자·콘솔이 변경을 적용했을 때 부른다(그 탭 자신의 접속 id 로). */
  markTxDirty: (connId: string) => void
  setAutoCommit: (connId: string, v: boolean) => Promise<void>
  commit: (connId: string) => Promise<void>
  rollback: (connId: string) => Promise<void>
}

/** 배열을 매번 새로 만들면 소비자의 `useMemo` 가 전부 깨지므로 빈 값은 고정 객체로. */
const NO_SCHEMAS: db.SchemaRef[] = []
const NO_TABLES: db.TableRef[] = []

export function useDbSession(conn: DbConnection | null): DbSession {
  const [sessions, setSessions] = useState<Record<string, Live>>({})
  /**
   * 세션이 없는 접속에 남은 커밋되지 않은 변경.
   *
   * 격자는 우리 세션과 무관하게 편집될 수 있다 — 다른 화면이 연 접속의 탭이 복원된
   * 경우다. 그때 `markTxDirty` 가 조용히 흘러가면 커밋할 것이 있는데 커밋 버튼이 없는
   * 상태가 되고, 앱을 닫는 순간 그 변경이 롤백된다. 그래서 세션 밖의 신호도 기억한다.
   */
  const [orphanTx, setOrphanTx] = useState<Set<string>>(new Set())
  const [connecting, setConnecting] = useState(false)
  const [loadingTables, setLoadingTables] = useState(false)
  // 오류도 접속에 묶어 둔다 — 접속을 바꾸면 앞 접속의 실패 메시지가 남아 있으면 안 된다.
  const [error, setError] = useState<{
    connId: string
    message: string
  } | null>(null)

  // 연결/해제와 목록 읽기는 서로 다른 늦은 응답을 버려야 해서 카운터를 따로 둔다.
  const connRun = useRef(0)
  const tablesRun = useRef(0)
  const autoTried = useRef(false)

  const connId = conn?.id ?? null
  const active = connId ? (sessions[connId] ?? null) : null

  /** 그 접속의 세션만 고친다. 없어졌으면(해제됐으면) 아무 일도 하지 않는다. */
  const patch = useCallback((id: string, p: Partial<Live>) => {
    setSessions((prev) =>
      prev[id] ? { ...prev, [id]: { ...prev[id], ...p } } : prev
    )
  }, [])

  /* ─────────────── 테이블 목록 ─────────────── */

  const loadTables = useCallback(
    async (id: string, s: db.SchemaRef | null) => {
      const seq = ++tablesRun.current
      setLoadingTables(true)
      try {
        const r = await db.tables(id, s?.catalog ?? null, s?.schema ?? null)
        if (seq !== tablesRun.current) return
        // 읽는 사이 접속이 바뀌었으면 그대로 버린다.
        patch(id, { tables: r.tables })
      } catch (e) {
        if (seq !== tablesRun.current) return
        setError({ connId: id, message: (e as Error).message })
      } finally {
        if (seq === tablesRun.current) setLoadingTables(false)
      }
    },
    [patch]
  )

  /* ─────────────── 연결 · 해제 ─────────────── */

  const connect = useCallback(
    async (password?: string) => {
      if (!conn) return
      const seq = ++connRun.current
      const id = conn.id
      setConnecting(true)
      setError(null)
      try {
        // (a′) 살아 있는 접속이 있으면 재연결하지 않는다 — 재연결은 옆 화면의
        // 트랜잭션을 말없이 롤백한다. 자동 커밋 값도 여기서 **다시 읽어** 온다.
        const existing =
          password === undefined
            ? await db.connInfo(id).catch(() => null)
            : null
        const info = existing ?? (await connectDb(conn, password ?? ""))
        const sr = await db.schemas(id)
        if (seq !== connRun.current) return

        // 접속이 알려 준 현재 스키마를 고르고, 없으면 첫 번째.
        const pick =
          sr.schemas.find(
            (s) =>
              (s.schema ?? null) === (sr.current.schema ?? null) &&
              (s.catalog ?? null) === (sr.current.catalog ?? null)
          ) ??
          sr.schemas[0] ??
          null

        setSessions((prev) => ({
          ...prev,
          [id]: {
            info,
            schemas: sr.schemas,
            schemaKey: pick ? schemaKeyOf(pick) : "",
            tables: [],
            // autoCommit 은 접속이 실제로 어떤 상태로 열려 있는지를 그대로 받는다.
            autoCommit: info.autoCommit,
            // 물려받은 접속이라면 남의 화면이 열어 둔 변경이 있을 수 있다. 우리가
            // 만든 게 아니면 판단할 근거가 없으므로 "깨끗하다"로 시작한다.
            txDirty: prev[id]?.txDirty ?? false,
          },
        }))
        setConnecting(false)
        // 테이블 목록은 연결과 분리해서 읽는다 — 목록 읽기가 실패해도 접속은 살아 있고,
        // 그때 "연결 실패"로 되돌리면 사용자가 멀쩡한 접속을 다시 붙이게 된다.
        await loadTables(id, pick)
      } catch (e) {
        if (seq !== connRun.current) return
        setSessions((prev) => {
          if (!prev[id]) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setError({ connId: id, message: (e as Error).message })
        setConnecting(false)
      }
    },
    [conn, loadTables]
  )

  /** 이 접속이 닫혔다는 사실을 상태에 반영한다(내가 닫았든, 다른 화면이 닫았든). */
  const forget = useCallback((id: string) => {
    setSessions((prev) => {
      if (!prev[id]) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setOrphanTx((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  /*
   * 다른 화면(데이터베이스 뷰어)이 같은 `connId` 를 닫은 경우. `db_disconnect` 는 브리지의
   * 접속을 **모든 화면에서** 닫으므로, 듣지 않으면 이쪽은 "연결됨"인 채로 남아 이미
   * 롤백된 편집에 커밋을 권하고 이후 질의가 전부 실패한다. (a) 에 적어 둔, id 를 일부러
   * 공유하는 선택의 뒷면이다.
   */
  useEffect(() => onDisconnected(forget), [forget])

  const disconnect = useCallback(async () => {
    if (!connId) return
    // 진행 중이던 연결 시도의 응답을 버린다(해제 직후 살아나면 안 된다).
    connRun.current++
    try {
      await db.disconnect(connId)
    } catch {
      // 이미 끊긴 접속이면 화면 상태만 정리한다.
    }
    // `forget` 이 세션과 함께 "주인 없는 미커밋" 표시까지 지운다 — 접속을 닫으면 JDBC 가
    // 트랜잭션을 롤백하므로 커밋할 것이 남아 있지 않다. 남겨 두면 툴바가 죽은 접속에
    // 대해 계속 커밋을 권하고, 그 커밋은 없는 connId 로 나가 오류만 띄운다.
    forget(connId)
    // 같은 접속을 보고 있는 다른 화면에도 알린다.
    announceDisconnect(connId)
    setError(null)
    setConnecting(false)
  }, [connId, forget])

  /**
   * 자동 연결 — 마운트당 한 번, 처음 들어온 접속에 대해서만. (c) 참고.
   *
   * `autoConnect` 는 사용자가 "이 접속은 켜자마자 붙여 달라"고 표시해 둔 값이라
   * 그대로 존중한다. 그 표시가 없으면 화면을 여는 것만으로 사내 DB 에 붙지 않는다.
   */
  useEffect(() => {
    if (autoTried.current || !conn) return
    autoTried.current = true
    if (!conn.autoConnect) return

    let cancelled = false
    void (async () => {
      // 파일 기반 엔진(H2·SQLite)과 계정이 없는 접속은 비밀번호 자체가 없다.
      const needsPassword =
        engineById(conn.engine).form === "server" && conn.user.trim() !== ""
      // 저장 여부 조회가 실패하면 "없다"로 본다 — 자동 시도가 오류창을 띄우는 것보다 낫다.
      const ok =
        !needsPassword ||
        (await db.hasSavedPassword(conn.id).catch(() => false))
      if (!ok || cancelled) return
      await connect()
    })()
    return () => {
      cancelled = true
    }
    // 처음 한 번만 도는 게 목적이라 `connect` 를 의존성에 넣지 않는다(넣으면 접속
    // 객체가 바뀔 때마다 이펙트가 다시 돌고, ref 가 막아도 정리 함수만 시끄러워진다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id])

  /* ─────────────── 스키마 ─────────────── */

  const currentSchema = useMemo(() => {
    if (!active) return null
    const s =
      active.schemas.find((x) => schemaKeyOf(x) === active.schemaKey) ??
      active.schemas[0] ??
      null
    return s ? { catalog: s.catalog, schema: s.schema } : null
  }, [active])

  const setSchemaKey = useCallback(
    (key: string) => {
      if (!active || !connId) return
      const s = active.schemas.find((x) => schemaKeyOf(x) === key) ?? null
      patch(connId, { schemaKey: key })
      void loadTables(connId, s)
    },
    [active, connId, patch, loadTables]
  )

  const reloadTables = useCallback(async () => {
    if (!active || !connId) return
    const s =
      active.schemas.find((x) => schemaKeyOf(x) === active.schemaKey) ??
      active.schemas[0] ??
      null
    await loadTables(connId, s)
  }, [active, connId, loadTables])

  /* ─────────────── 트랜잭션 ─────────────── */

  const setAutoCommit = useCallback(
    async (id: string, v: boolean) => {
      try {
        const r = await db.setAutoCommit(id, v)
        patch(id, {
          autoCommit: r.autoCommit,
          // 자동 커밋을 켜면 JDBC 규약상 열려 있던 트랜잭션이 커밋된다.
          ...(r.autoCommit ? { txDirty: false } : {}),
        })
        if (r.autoCommit)
          setOrphanTx((prev) => {
            if (!prev.has(id)) return prev
            const next = new Set(prev)
            next.delete(id)
            return next
          })
      } catch (e) {
        setError({ connId: id, message: (e as Error).message })
      }
    },
    [patch]
  )

  const markTxDirty = useCallback(
    (id: string) => {
      // 세션이 있으면 그 세션에, 없으면 별도 칸에 — 둘 중 어디에 들어갔는지는
      // `txDirtyFor` 가 같은 규칙으로 읽으므로 화면은 구분할 필요가 없다.
      patch(id, { txDirty: true })
      // 세션이 **없을 때만** 별도 칸에 적는다. 세션이 있으면 그쪽 `txDirty` 가 진실이고,
      // 양쪽에 다 넣으면 해제한 뒤에도(세션은 지워지지만 이 칸은 남아) 이미 JDBC 가
      // 롤백한 트랜잭션에 대해 미커밋 경고와 커밋·롤백 버튼이 계속 뜬다 — 그 커밋은
      // 죽은 connId 로 나가 사용자가 하지도 않은 오류를 띄운다.
      if (sessions[id]) return
      setOrphanTx((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
    },
    [patch, sessions]
  )

  const clearTxDirty = useCallback(
    (id: string) => {
      patch(id, { txDirty: false })
      setOrphanTx((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    },
    [patch]
  )

  const runTx = useCallback(
    async (kind: "commit" | "rollback", id: string) => {
      try {
        const r =
          kind === "commit" ? await db.commit(id) : await db.rollback(id)
        const ok = "committed" in r ? r.committed : r.rolledBack
        if (ok) {
          clearTxDirty(id)
          setError(null)
        } else {
          // 사용자가 누른 일이 안 됐으면 그 이유는 오류 자리에 그대로 내보낸다.
          setError({
            connId: id,
            message: r.reason ?? "적용할 트랜잭션이 없습니다.",
          })
        }
      } catch (e) {
        setError({ connId: id, message: (e as Error).message })
      }
    },
    [clearTxDirty]
  )

  const commit = useCallback((id: string) => runTx("commit", id), [runTx])
  const rollback = useCallback((id: string) => runTx("rollback", id), [runTx])

  const autoCommitFor = useCallback(
    // 우리가 모르는 접속(아직 붙지 않았거나 다른 화면이 연 것)은 자동 커밋으로 본다 —
    // 드라이버 기본값이 그렇고, 없는 상태를 "수동 커밋"으로 꾸미면 있지도 않은 커밋
    // 버튼을 누르게 만든다.
    (id: string) => sessions[id]?.autoCommit ?? true,
    [sessions]
  )
  const txDirtyFor = useCallback(
    // 세션이 있으면 세션의 값이 정답이고(커밋·롤백이 거기서 지워진다), 없으면 세션 밖에서
    // 받은 신호를 본다 — 그것이 "커밋할 것이 남아 있다"는 유일한 근거다.
    (id: string) => sessions[id]?.txDirty ?? orphanTx.has(id),
    [sessions, orphanTx]
  )
  const hasSession = useCallback((id: string) => !!sessions[id], [sessions])

  return useMemo<DbSession>(
    () => ({
      info: active?.info ?? null,
      connecting,
      connError:
        error && connId && error.connId === connId ? error.message : null,
      schemas: active?.schemas ?? NO_SCHEMAS,
      schemaKey: active?.schemaKey ?? null,
      setSchemaKey,
      currentSchema,
      tables: active?.tables ?? NO_TABLES,
      loadingTables,
      connect,
      disconnect,
      reloadTables,
      autoCommit: active?.autoCommit ?? true,
      txDirty: active?.txDirty ?? false,
      autoCommitFor,
      txDirtyFor,
      hasSession,
      markTxDirty,
      setAutoCommit,
      commit,
      rollback,
    }),
    [
      active,
      connecting,
      error,
      connId,
      setSchemaKey,
      currentSchema,
      loadingTables,
      connect,
      disconnect,
      reloadTables,
      autoCommitFor,
      txDirtyFor,
      hasSession,
      markTxDirty,
      setAutoCommit,
      commit,
      rollback,
    ]
  )
}
