/**
 * IntelliJ Cowork 화면의 **가운데 탭 모델** — 소스 파일 · 테이블 격자 · SQL 콘솔이 한 줄에
 * 섞여 열린다(`DevTab` 의 세 갈래가 그 이유를 적어 두었다).
 *
 * 셸의 `use-open-tabs.ts` 와 규칙이 하나만 다르다: **여기서는 마지막 탭도 닫을 수 있다.**
 * 셸은 탭이 전부 사라지면 보여 줄 뷰가 없어 닫기를 막지만, 이 화면은 편집 영역이 비어도
 * 트리·데이터베이스·아래 독이 그대로 남아 있어 "아무것도 안 연 상태"가 정상이다. 그래서
 * `activeId` 가 `null` 일 수 있고, 화면은 그 자리에 안내를 그린다.
 *
 * 나머지는 셸과 같다 — 활성 탭을 닫으면 **오른쪽 이웃**, 없으면 왼쪽. IntelliJ 도 같은
 * 규칙이고, 이게 아니면 여러 개를 연달아 닫을 때 커서가 목록을 앞뒤로 튄다.
 *
 * 열린 탭 자체를 localStorage 에 담는다(셸은 메뉴 id 만 담는다). 파일 경로·테이블 참조는
 * 우리가 만들어 낼 수 없는 값이라, id 만 저장하면 앱을 다시 켰을 때 무엇을 열어 두었는지
 * 복원할 수 없기 때문이다.
 */

import { useCallback, useMemo } from "react"

import { useLocalStorage } from "@/lib/use-local-storage"
import {
  KAFKA_BROKERS_TAB_ID,
  KAFKA_GROUPS_TAB_ID,
  NS,
  type DevTab,
} from "./types"

const TABS_KEY = `${NS}.tabs`
const ACTIVE_KEY = `${NS}.activeTab`

export interface DevTabsState {
  tabs: DevTab[]
  /** 열린 탭이 없으면 `null`. */
  activeId: string | null
  /** `activeId` 가 가리키는 탭(찾는 코드를 화면마다 반복하지 않도록). */
  activeTab: DevTab | null
  /** 이미 같은 id 가 있으면 **활성화만** 한다(같은 파일이 두 번 열리지 않는다). */
  open: (tab: DevTab) => void
  close: (id: string) => void
  /**
   * 여러 탭을 한 번에 닫는다.
   *
   * `close` 를 반복해 부르면 안 된다 — 각 호출이 **같은 렌더의 `tabs` 배열**에서
   * 자기 하나만 뺀 새 배열을 쓰므로, 마지막 호출이 앞의 것들을 되살린다.
   */
  closeMany: (ids: string[]) => void
  /** 이 탭만 남기고 전부 닫는다. */
  closeOthers: (id: string) => void
  closeAll: () => void
  activate: (id: string) => void
}

const NO_TABS: DevTab[] = []

/**
 * 저장값이 우리가 아는 모양인지 본다.
 *
 * localStorage 는 사람이 고칠 수도, 예전 버전이 남겨 둘 수도 있는 값이다. 모양이 깨진
 * 항목 하나가 렌더에서 터지면 화면이 통째로 흰 채로 남으므로, 읽는 자리에서 걸러 낸다.
 *
 * ⚠️ **탭 종류를 추가하면 반드시 여기에 arm 을 같이 넣을 것.** 모르는 `kind` 는 `false` 이고
 * `sanitize` 가 조용히 버리므로, 빠뜨리면 그 탭은 이번 세션 동안 완벽하게 동작하다가
 * 앱을 다시 켜는 순간 사라진다 — 아무 데도 에러가 남지 않아 원인을 짚을 단서가 없다.
 * arm 마다 **자기 필드**를 확인하는 것이 요점이다: 종류만 보고 통과시키면 `index` 가 없는
 * `esIndex` 탭이 살아남아 빈 인덱스를 조회한다.
 */
function isDevTab(v: unknown): v is DevTab {
  if (!v || typeof v !== "object") return false
  const t = v as Record<string, unknown>
  if (typeof t.id !== "string" || t.id === "") return false
  if (typeof t.name !== "string") return false
  if (t.kind === "file") return typeof t.path === "string" && t.path !== ""
  if (t.kind === "table")
    return (
      typeof t.connId === "string" && !!t.table && typeof t.table === "object"
    )
  if (t.kind === "sql") return typeof t.connId === "string"
  if (t.kind === "esIndex") return typeof t.index === "string" && t.index !== ""
  if (t.kind === "kafkaTopic")
    return typeof t.topic === "string" && t.topic !== ""
  // 싱글턴 두 종류는 들고 있는 필드가 id 뿐이라, 그 id 가 지금 쓰는 상수와 같은지가
  // 곧 유효성이다 — 예전 판이 남긴 다른 철자를 통과시키면 탭 줄에는 있는데 본문이
  // 안 그려지고(그 id 로 만들 arm 이 없다), 새로 열어도 중복 판정에 걸려 안 열린다.
  if (t.kind === "kafkaGroups") return t.id === KAFKA_GROUPS_TAB_ID
  if (t.kind === "kafkaBrokers") return t.id === KAFKA_BROKERS_TAB_ID
  return false
}

/** 모양이 깨진 항목과 중복 id 를 걸러 낸다(id 가 곧 정체성이다). */
function sanitize(list: unknown): DevTab[] {
  if (!Array.isArray(list)) return NO_TABS
  const out: DevTab[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (!isDevTab(item) || seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

export function useDevTabs(): DevTabsState {
  const [storedTabs, setStoredTabs] = useLocalStorage<DevTab[]>(TABS_KEY, [])
  const [storedActive, setStoredActive] = useLocalStorage<string | null>(
    ACTIVE_KEY,
    null
  )

  // 보정은 **렌더 시점**에 한다(상태를 되쓰지 않는다) — 셸의 탭 모델과 같은 규칙이다.
  // 아래 콜백들의 의존성이므로 매 렌더 새 배열이 되지 않도록 memo 한다.
  const tabs = useMemo(() => sanitize(storedTabs), [storedTabs])

  const activeId = useMemo(() => {
    if (tabs.length === 0) return null
    return tabs.some((t) => t.id === storedActive)
      ? storedActive
      : (tabs[0]?.id ?? null)
  }, [tabs, storedActive])

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeId) ?? null,
    [tabs, activeId]
  )

  const open = useCallback(
    (tab: DevTab) => {
      setStoredTabs((prev) => {
        const cur = sanitize(prev)
        // 이미 있으면 **기존 객체를 그대로 둔다** — 같은 내용으로 갈아끼우면 참조가
        // 바뀌어 그 탭의 본문이 통째로 다시 그려진다(격자는 조회까지 다시 한다).
        return cur.some((t) => t.id === tab.id) ? cur : [...cur, tab]
      })
      setStoredActive(tab.id)
    },
    [setStoredTabs, setStoredActive]
  )

  const close = useCallback(
    (id: string) => {
      const idx = tabs.findIndex((t) => t.id === id)
      if (idx === -1) return
      setStoredTabs(tabs.filter((t) => t.id !== id))
      // 오른쪽 이웃 → 없으면 왼쪽 → 그것도 없으면 빈 편집 영역.
      if (activeId === id) {
        setStoredActive(tabs[idx + 1]?.id ?? tabs[idx - 1]?.id ?? null)
      }
    },
    [tabs, activeId, setStoredTabs, setStoredActive]
  )

  const closeMany = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return
      const drop = new Set(ids)
      const remaining = tabs.filter((t) => !drop.has(t.id))
      if (remaining.length === tabs.length) return
      setStoredTabs(remaining)
      setStoredActive((cur) =>
        cur && !drop.has(cur) ? cur : (remaining[0]?.id ?? null)
      )
    },
    [tabs, setStoredTabs, setStoredActive]
  )

  const closeOthers = useCallback(
    (id: string) => {
      const keep = tabs.find((t) => t.id === id)
      if (!keep) return
      setStoredTabs([keep])
      setStoredActive(keep.id)
    },
    [tabs, setStoredTabs, setStoredActive]
  )

  const closeAll = useCallback(() => {
    setStoredTabs([])
    setStoredActive(null)
  }, [setStoredTabs, setStoredActive])

  const activate = useCallback(
    (id: string) => {
      setStoredActive(id)
    },
    [setStoredActive]
  )

  return {
    tabs,
    activeId,
    activeTab,
    open,
    close,
    closeMany,
    closeOthers,
    closeAll,
    activate,
  }
}
