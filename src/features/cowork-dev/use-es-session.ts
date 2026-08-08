import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { isTauri } from "@/lib/tauri"
import {
  EsClient,
  EsError,
  type IndexRow,
} from "@/features/es-viewer/es-client"
import { useEsConn } from "@/features/es-viewer/es-conn-store"
import { sortIndices } from "@/features/es-viewer/es-utils"

/**
 * IntelliJ Cowork 화면의 Elasticsearch 세션 — 클라이언트 · 클러스터 정보 · 인덱스 목록을
 * 한 훅이 통째로 들고 있다.
 *
 * 이 흐름은 원래 `es-viewer-view.tsx` 안에 인라인으로 있던 것이다. 두 번째 화면이 같은
 * 순서(`GET /` → `_cat/indices` → 정렬)를 다시 필요로 하는데, 복사해 두면 정렬 규칙이나
 * 오류 문구가 한쪽만 바뀌어 조용히 어긋난다(정렬 자체는 `es-utils.sortIndices` 가 이미
 * 두 화면의 공통 규칙이다).
 *
 * 반드시 알아야 할 네 가지:
 *
 * **(a) 인덱스 목록의 주인이 패널이 아니라 이 훅이다.** 가운데 탭으로 열리는
 * `IndexPane` 이 `meta?: IndexRow`(health·문서 수·크기)를 받는데 그 탭을 마운트하는 쪽은
 * 오른쪽 패널이 아니라 **루트**다. 목록을 패널 안에 두면 루트가 그 값을 읽을 길이 없어
 * 탭 머리의 요약이 빈 채로 뜬다.
 *
 * **(b) `connSeq` 는 재연결 때 패널을 강제로 새로 만들기 위한 값이다.** 루트는 탭 패널을
 * `${connSeq}:${index}` 로 키를 만든다 — 주소를 고쳐 다시 붙이면 `client` 가 새 객체로
 * 바뀌는데, 키가 그대로면 이미 마운트된 패널이 **처음 받은 클라이언트를 계속 들고 있어**
 * 옛 클러스터를 조회한다. 그래서 연결이 성공할 때마다 무조건 하나 올린다.
 *
 * **(c) 뷰어의 `connect()` 에서 "저장해 둔 탭 복원" 블록은 가져오지 않았다.** 그 블록은
 * `myspace.esTabs` 를 직접 읽고 **그대로 다시 쓴다**. 이 화면의 탭 모델은 `useDevTabs`
 * 이고 파일·테이블·인덱스가 한 줄에 섞여 있어서, 그 키를 건드리면 Elasticsearch 뷰어의
 * 탭이 이유 없이 닫히거나(우리 목록으로 덮인다) 이쪽 탭이 인덱스만 남게 된다. 연결 정보는
 * `useEsConn()` 으로 **공유**하지만 탭 목록은 화면마다 다른 값이라 공유할 대상이 아니다.
 *
 * **(d) 해제는 Rust 를 부르지 않는다.** `es_request` 는 요청마다 접속 정보를 통째로 받는
 * 무상태 명령이라 끊을 대상 자체가 없다 — 그래서 `disconnect` 는 화면 상태만 비우는
 * 동기 함수다(`db_disconnect` 처럼 옆 화면의 세션을 함께 끊는 위험이 아예 없다).
 */

/**
 * 인덱스별 조회 상태(`es-viewer/persisted.ts`)를 담아 둘 칸의 화면 접두사.
 *
 * 접두사가 없으면 Elasticsearch 뷰어와 한 칸을 나눠 쓴다 — 저쪽에서 인덱스를 지울 때 도는
 * `purgeIndex` 가 이쪽 조회 조건을 지우고, 무엇보다 검색 모드·페이지 크기는 **패널이
 * 마운트될 때 한 번만 읽는 값**이라 부딪혀도 그 자리에서는 아무 일도 없고 다음에 여는
 * 탭이 남의 설정을 물려받는다(조용히 틀린다).
 *
 * 여기(세션 훅)에 두는 이유: 이 값을 쓰는 곳이 **패널의 검색어와 루트가 마운트하는
 * `IndexPane` 의 `scope`** 두 군데인데, 둘 다 이 훅을 이미 가져가므로 같은 import 로
 * 따라온다. 상수를 두 벌 적으면 한 글자 차이로 저장 칸이 갈린다.
 */
export const ES_SCOPE = "coworkDev"

export interface EsSession {
  /** 연결돼 있으면 클라이언트, 아니면 `null`. */
  client: EsClient | null
  /** 연결 성공마다 1 증가 — 루트가 탭 패널의 `key` 에 섞어 재연결 때 새로 만든다((b) 참고). */
  connSeq: number
  /** `클러스터명 · v버전` 한 줄. 연결돼 있지 않으면 `null`. */
  cluster: string | null
  /** 정렬된 인덱스 목록((a) 참고 — 루트도 이 값을 읽는다). */
  indices: IndexRow[]
  connecting: boolean
  /**
   * 마지막 실패 메시지. `EsError` 는 메시지와 상세를 **줄바꿈으로 이어** 담으므로
   * 표시하는 쪽은 반드시 `whitespace-pre-wrap` 을 걸어야 한다.
   */
  connError: string | null
  connect: () => Promise<void>
  /** 화면 상태만 비운다((d) 참고). */
  disconnect: () => void
  reloadIndices: () => Promise<void>
}

/** 배열을 매번 새로 만들면 소비자의 `useMemo` 가 전부 깨지므로 빈 값은 고정 객체로. */
const NO_INDICES: IndexRow[] = []

export function useEsSession(): EsSession {
  const { conn } = useEsConn()

  const [client, setClient] = useState<EsClient | null>(null)
  const [connSeq, setConnSeq] = useState(0)
  const [cluster, setCluster] = useState<string | null>(null)
  const [indices, setIndices] = useState<IndexRow[]>(NO_INDICES)
  const [connecting, setConnecting] = useState(false)
  const [connError, setConnError] = useState<string | null>(null)

  // 늦게 도착한 응답을 버리기 위한 순번. 주소를 고쳐 두 번 누르거나 연결 중에 해제하면
  // 앞의 요청이 나중에 돌아와 죽은 클라이언트를 되살릴 수 있다.
  const runRef = useRef(0)
  const autoTried = useRef(false)

  const reloadIndices = useCallback(async () => {
    if (!client) return
    try {
      setIndices(sortIndices(await client.indices()))
    } catch {
      // 목록 갱신 실패는 조용히 무시한다 — 연결 자체는 살아 있고, 여기서 오류를 세우면
      // 멀쩡한 클러스터를 사용자가 다시 붙이게 된다(뷰어와 같은 판단).
    }
  }, [client])

  const connect = useCallback(async () => {
    if (!conn.host.trim()) {
      setConnError("호스트를 입력하세요. 접속 설정에서 주소를 넣으세요.")
      return
    }
    const seq = ++runRef.current
    setConnecting(true)
    setConnError(null)
    const c = new EsClient(conn)
    try {
      const info = await c.info()
      const list = sortIndices(await c.indices())
      if (seq !== runRef.current) return
      setClient(c)
      // 재연결이면 이 증가가 가운데 탭들을 새 클라이언트로 갈아 끼운다((b) 참고).
      setConnSeq((s) => s + 1)
      setCluster(
        `${info.cluster_name ?? "unknown"} · v${info.version?.number ?? "?"}`
      )
      setIndices(list)
    } catch (e) {
      if (seq !== runRef.current) return
      setClient(null)
      setCluster(null)
      setIndices(NO_INDICES)
      setConnError(
        e instanceof EsError ? `${e.message}\n${e.detail}` : String(e)
      )
    } finally {
      if (seq === runRef.current) setConnecting(false)
    }
  }, [conn])

  const disconnect = useCallback(() => {
    // 진행 중이던 연결 시도의 응답을 버린다(해제 직후 살아나면 안 된다).
    runRef.current++
    setClient(null)
    setCluster(null)
    setIndices(NO_INDICES)
    setConnError(null)
    setConnecting(false)
  }, [])

  /**
   * 자동 연결 — 마운트당 최대 한 번.
   *
   * `autoConnect` 는 접속 정보와 함께 **뷰어와 공유하는 값**이라 두 화면이 앱을 켤 때
   * 각각 붙는다. ES 에서는 그래도 괜찮다: 여는 요청이 `GET /` 와 `_cat/indices` 두 번뿐이고
   * 서버에 남는 상태가 없다(Kafka 와 달리 캐시를 걷어 내는 짝도 없다).
   *
   * `isTauri()` 로 막는 이유: 이 훅은 루트가 "데스크톱 앱에서만 사용할 수 있습니다" 를
   * 그리기 **전에** 불린다(훅은 조건부로 부를 수 없다). 그대로 두면 브라우저 개발 모드에서
   * 마운트만으로 IPC 오류가 뜬다.
   */
  useEffect(() => {
    if (autoTried.current) return
    autoTried.current = true
    if (!isTauri()) return
    // 연결 시작이 곧 상태 변경이라 규칙에 걸리는데, "화면을 열면 붙는다"가 요구 자체다
    // (뷰어의 자동 연결도 같은 예외를 달고 있다).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (conn.autoConnect && conn.host.trim()) void connect()
    // 처음 한 번만 도는 게 목적이라 `connect`·`conn` 을 의존성에 넣지 않는다(넣으면 주소를
    // 고칠 때마다 이펙트가 다시 돌고, ref 가 막아도 시끄러워진다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return useMemo<EsSession>(
    () => ({
      client,
      connSeq,
      cluster,
      indices,
      connecting,
      connError,
      connect,
      disconnect,
      reloadIndices,
    }),
    [
      client,
      connSeq,
      cluster,
      indices,
      connecting,
      connError,
      connect,
      disconnect,
      reloadIndices,
    ]
  )
}
