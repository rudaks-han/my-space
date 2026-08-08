import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { isTauri } from "@/lib/tauri"
import {
  KafkaClient,
  type ClusterInfo,
  type TopicInfo,
} from "@/features/kafka-viewer/kafka-client"
import { useKafkaConn } from "@/features/kafka-viewer/kafka-conn-store"

/**
 * IntelliJ Cowork 화면의 Kafka 세션 — 클라이언트 · 클러스터 개요 · 토픽 목록을 한 훅이
 * 통째로 들고 있다. `use-es-session.ts` 와 같은 모양이고, 이유도 같다(목록의 주인이
 * 패널이 아니라 이 훅인 것은 가운데 탭 `TopicPane` 이 `meta?: TopicInfo` 를 받고 그 탭을
 * 마운트하는 쪽이 루트이기 때문이다).
 *
 * ES 와 다른 네 가지만 적는다:
 *
 * **(a) 붙기 전에 반드시 `client.disconnect()` 를 먼저 부른다.** `kafka.rs` 는 브로커
 * 주소 문자열별로 메타데이터 컨슈머를 프로세스 전역 맵에 캐시하는데, 주소를 고쳐 다시
 * 붙이는 경우 옛 항목이 그대로 쓰이면 새 주소를 보지 않는다. 뷰어의 `connect()` 가 하는
 * 일과 한 글자도 다르지 않다.
 *
 * **(a′) 그 해제는 다른 화면의 캐시까지 걷어 낸다 — 그리고 그건 양성이다.**
 * `kafka_disconnect` 는 프로세스 전역에서 그 주소의 컨슈머를 지우므로, 여기서 [연결]을
 * 누르면 Kafka 뷰어의 다음 호출이 캐시를 다시 만드는 만큼 느려진다. **상태를 잃지도, 오류가
 * 나지도 않는다**(캐시는 필요할 때 다시 채워진다). `db_disconnect` 와 모양은 같지만 결과가
 * 다르다 — 그쪽은 옆 화면의 트랜잭션을 통째로 롤백하므로 물려받기(`db_conn_info`)를 먼저
 * 하는데, 여기는 그런 장치가 필요 없다.
 *
 * **(b) 첫 목록은 건수를 세지 않는다.** `withCounts` 는 파티션마다 워터마크를 왕복해서
 * 읽으므로 토픽이 수백 개인 클러스터에서 자동 연결이 몇 초씩 걸린다. 좁은 패널의 줄에는
 * `p3`(파티션 수)만 있어도 충분하고, 건수는 사용자가 체크박스로 켤 때만 읽는다.
 *
 * **(b′) 그래서 이 플래그는 `persisted.ts` 에 담지 않는다.** 저쪽 `getWithCounts` 의
 * 기본값이 **true** 라, 한 번도 만지지 않은 사용자에게도 true 를 돌려준다 — 그 값으로
 * 체크박스를 그리면 "건수 계산 켜짐"이라고 표시된 채 목록에는 `p3` 만 있는 상태가 된다
 * (화면이 거짓말을 한다). 검색어와 내부 토픽 표시는 기본값이 각각 `""`·false 라 이 문제가
 * 없어서 그쪽은 저장 칸(`KAFKA_SCOPE`)에 담는다.
 *
 * **(c) 뷰어의 "저장해 둔 탭 복원" 블록은 가져오지 않았다.** ES 쪽과 같은 이유다 —
 * 그 블록이 `myspace.kafkaTabs` 를 읽고 그대로 다시 써서, 이 화면의 `useDevTabs` 와
 * 부딪히면 어느 한쪽 탭이 이유 없이 닫힌다.
 */

/**
 * 토픽별 조회 조건(`kafka-viewer/persisted.ts`)을 담아 둘 칸의 화면 접두사.
 *
 * ES 보다 이쪽이 더 급하다: 저쪽 `purgeTopic` 은 **토픽을 지울 때가 아니라 탭을 닫을
 * 때마다** 돌기 때문에, 칸을 나눠 쓰면 Kafka 뷰어에서 토픽 탭 하나를 닫는 것만으로
 * 이 화면에 열린 같은 토픽의 파티션·시작 위치·오프셋·검색어가 통째로 사라진다.
 *
 * 세션 훅에 두는 이유는 `ES_SCOPE` 와 같다 — 패널의 목록 상태와 루트가 마운트하는
 * `TopicPane` 의 `scope` 두 군데가 이 훅을 이미 가져가므로 같은 import 로 따라온다.
 */
export const KAFKA_SCOPE = "coworkDev"

export interface KafkaSession {
  client: KafkaClient | null
  /** 연결 성공마다 1 증가 — 루트가 탭 패널의 `key` 에 섞어 재연결 때 새로 만든다. */
  connSeq: number
  cluster: ClusterInfo | null
  topics: TopicInfo[]
  connecting: boolean
  /** 목록만 다시 읽는 중(연결은 살아 있다) — 새로고침 아이콘의 회전에 쓴다. */
  reloading: boolean
  connError: string | null
  /** 파티션 워터마크를 읽어 메시지 건수를 채울지((b)·(b′) 참고 — 저장하지 않는다). */
  withCounts: boolean
  /** 플래그만 바꾼다. 목록을 다시 읽는 것은 부른 쪽이 `reloadTopics(v)` 로 한다. */
  setWithCounts: (v: boolean) => void
  connect: () => Promise<void>
  /** 화면 상태만 비운다 — Rust 캐시는 그대로 둔다((a′) 참고, 다음 연결이 어차피 갈아 낸다). */
  disconnect: () => void
  reloadTopics: (counts: boolean) => Promise<void>
}

/** 배열을 매번 새로 만들면 소비자의 `useMemo` 가 전부 깨지므로 빈 값은 고정 객체로. */
const NO_TOPICS: TopicInfo[] = []

export function useKafkaSession(): KafkaSession {
  const { conn } = useKafkaConn()

  const [client, setClient] = useState<KafkaClient | null>(null)
  const [connSeq, setConnSeq] = useState(0)
  const [cluster, setCluster] = useState<ClusterInfo | null>(null)
  const [topics, setTopics] = useState<TopicInfo[]>(NO_TOPICS)
  const [connecting, setConnecting] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [connError, setConnError] = useState<string | null>(null)
  const [withCounts, setWithCounts] = useState(false)

  // 연결과 목록 읽기는 서로 다른 늦은 응답을 버려야 해서 순번을 따로 둔다.
  const runRef = useRef(0)
  const listRef = useRef(0)
  const autoTried = useRef(false)

  const reloadTopics = useCallback(
    async (counts: boolean) => {
      if (!client) return
      const seq = ++listRef.current
      setReloading(true)
      try {
        const list = await client.topics(counts)
        if (seq !== listRef.current) return
        setTopics(list)
      } catch {
        // 목록 갱신 실패는 조용히 무시한다 — 연결 자체는 살아 있고, 여기서 오류를 세우면
        // 멀쩡한 브로커를 사용자가 다시 붙이게 된다(뷰어와 같은 판단).
      } finally {
        if (seq === listRef.current) setReloading(false)
      }
    },
    [client]
  )

  const connect = useCallback(async () => {
    if (!conn.brokers.trim()) {
      setConnError(
        "브로커 주소를 입력하세요. (예: 172.16.0.10:9092) 접속 설정에서 넣으세요."
      )
      return
    }
    const seq = ++runRef.current
    setConnecting(true)
    setConnError(null)
    const c = new KafkaClient(conn)
    try {
      // (a) 주소를 바꿔 재연결할 수 있으므로 캐시된 연결을 먼저 버린다.
      await c.disconnect()
      const info = await c.connect()
      // (b) 첫 목록은 건수 없이 — 여기서 `withCounts` 를 보면 자동 연결이 워터마크
      // 왕복에 묶여 화면이 열리는 데만 몇 초가 든다.
      const list = await c.topics(false)
      if (seq !== runRef.current) return
      setClient(c)
      setConnSeq((s) => s + 1)
      setCluster(info)
      setTopics(list)
      setWithCounts(false)
    } catch (e) {
      if (seq !== runRef.current) return
      setClient(null)
      setCluster(null)
      setTopics(NO_TOPICS)
      setConnError((e as Error).message)
    } finally {
      if (seq === runRef.current) setConnecting(false)
    }
  }, [conn])

  const disconnect = useCallback(() => {
    // 진행 중이던 연결·목록 요청의 응답을 버린다(해제 직후 살아나면 안 된다).
    runRef.current++
    listRef.current++
    setClient(null)
    setCluster(null)
    setTopics(NO_TOPICS)
    setConnError(null)
    setConnecting(false)
    setReloading(false)
  }, [])

  /**
   * 자동 연결 — 마운트당 최대 한 번.
   *
   * `autoConnect` 는 뷰어와 공유하는 값이라 두 화면이 앱을 켤 때 각각 붙는다. 그래도
   * 괜찮은 것은 (b) 때문이다: 여는 호출이 `kafka_connect` 와 건수 없는 `kafka_topics`
   * 두 번뿐이다. 두 화면이 겹쳐 들어오면 앞에서 만든 캐시를 뒤가 한 번 걷어 내지만
   * 그건 (a′) 대로 느려짐일 뿐이다.
   *
   * `isTauri()` 로 막는 이유는 ES 쪽과 같다 — 이 훅은 루트가 "데스크톱 앱에서만" 안내를
   * 그리기 전에 불리므로(훅은 조건부로 부를 수 없다), 브라우저 개발 모드에서 마운트만으로
   * IPC 오류가 뜬다.
   */
  useEffect(() => {
    if (autoTried.current) return
    autoTried.current = true
    if (!isTauri()) return
    // 연결 시작이 곧 상태 변경이라 규칙에 걸리는데, "화면을 열면 붙는다"가 요구 자체다
    // (뷰어의 자동 연결도 같은 예외를 달고 있다).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (conn.autoConnect && conn.brokers.trim()) void connect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return useMemo<KafkaSession>(
    () => ({
      client,
      connSeq,
      cluster,
      topics,
      connecting,
      reloading,
      connError,
      withCounts,
      setWithCounts,
      connect,
      disconnect,
      reloadTopics,
    }),
    [
      client,
      connSeq,
      cluster,
      topics,
      connecting,
      reloading,
      connError,
      withCounts,
      connect,
      disconnect,
      reloadTopics,
    ]
  )
}
