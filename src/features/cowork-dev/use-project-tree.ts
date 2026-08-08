import { useCallback, useEffect, useRef, useState } from "react"

import type { DevEntry } from "@/features/cowork-dev/types"
import { isTauri, trackedInvoke } from "@/lib/tauri"

/** `useProjectTree` 가 돌려주는 것 — `FileTree` 가 통째로 받아 그린다. */
export interface ProjectTree {
  /** `rel` → 그 폴더의 바로 아래 항목들. 키 `""` 가 프로젝트 루트다. */
  children: Record<string, DevEntry[]>
  /** 펼쳐 둔 폴더의 `rel` 집합. */
  expanded: Set<string>
  /** 지금 목록을 읽고 있는 폴더의 `rel` 집합(그 줄에 스피너를 돌린다). */
  loading: Set<string>
  error: string | null
  /** 폴더 한 줄을 눌렀을 때 — 펼쳐져 있으면 접고, 아니면 `ensure`. */
  toggle: (rel: string) => void
  /** 툴바의 새로고침. 루트와 **펼쳐 둔 폴더만** 다시 읽는다. */
  reload: () => Promise<void>
  /** 이 폴더가 펼쳐져 있고 자식이 읽혀 있음을 보장한다(탭에서 파일 위치로 점프할 때 조상마다 호출). */
  ensure: (rel: string) => Promise<void>
  /**
   * 이 폴더 하나만 **강제로** 다시 읽는다(파일 조작 뒤). 접혀 있었으면 펼친다 —
   * 방금 만든 파일이 접힌 폴더 안에 있으면 아무 일도 없었던 것처럼 보인다.
   *
   * `ensure` 로는 안 된다: 그쪽은 캐시가 있으면 아무것도 하지 않으므로 새로 만든 파일이
   * 목록에 나타나지 않는다. `reload` 로도 안 된다: 펼쳐 둔 폴더를 전부 다시 읽는 낭비다.
   */
  refresh: (rel: string) => Promise<void>
}

/**
 * 프로젝트 파일 트리 — **한 번에 한 겹씩** 읽는다(`dev_list_dir`).
 *
 * cowork 저장소는 파일이 수만 개라 통째로 훑으면 첫 그리기가 몇 초씩 걸린다. 그래서
 * 펼친 폴더만 읽고 그 결과를 `rel` 로 캐시한다. 접었다 다시 펼치는 것은 캐시 적중이라
 * 즉시 열리고, 디스크가 바뀌었을 때는 툴바의 새로고침이 답이다.
 *
 * **주기적으로 다시 읽지 않는다.** 탭은 keep-alive 라 한 번 열면 닫을 때까지 살아 있으므로
 * 폴링을 걸면 쓰지 않는 동안에도 저장소를 계속 긁는다(빌드 산출물이 쏟아지는 중이면 더 나쁘다).
 * 트리가 갱신되는 계기는 두 개뿐 — 툴바의 새로고침, 그리고 `root` 변경(설정 → Cowork).
 */
export function useProjectTree(root: string): ProjectTree {
  const [children, setChildren] = useState<Record<string, DevEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  // 상태의 거울. 비동기 콜백이 "지금 값"을 봐야 하는데(중복 요청 방지·접힘 판정),
  // 의존성으로 넣으면 toggle/ensure 가 매 렌더 새로 만들어져 자식이 통째로 리렌더된다.
  const childrenRef = useRef(children)
  const expandedRef = useRef(expanded)
  const inflightRef = useRef(new Set<string>())
  // 늦게 도착한 응답을 버리기 위한 세대 번호 — 루트를 바꾸자마자 이전 저장소의
  // 목록이 도착해 새 트리에 섞이는 것을 막는다.
  const seqRef = useRef(0)
  const rootRef = useRef<string | null>(null)

  const putChildren = useCallback((rel: string, list: DevEntry[]) => {
    const next = { ...childrenRef.current, [rel]: list }
    childrenRef.current = next
    setChildren(next)
  }, [])

  const markLoading = useCallback((rel: string, on: boolean) => {
    setLoading((prev) => {
      const next = new Set(prev)
      if (on) next.add(rel)
      else next.delete(rel)
      return next
    })
  }, [])

  const setExpandedSet = useCallback((next: Set<string>) => {
    expandedRef.current = next
    setExpanded(next)
  }, [])

  /** 폴더 하나를 읽어 캐시에 넣는다. 세대가 바뀌었으면 결과를 버린다. */
  const load = useCallback(
    async (rel: string) => {
      const seq = seqRef.current
      inflightRef.current.add(rel)
      markLoading(rel, true)
      try {
        const list = await trackedInvoke<DevEntry[]>("dev_list_dir", {
          root,
          rel,
        })
        if (seq !== seqRef.current) return
        putChildren(rel, list)
        setError(null)
      } catch (e) {
        if (seq !== seqRef.current) return
        setError(String(e))
      } finally {
        inflightRef.current.delete(rel)
        markLoading(rel, false)
      }
    },
    [markLoading, putChildren, root]
  )

  const reload = useCallback(async () => {
    seqRef.current += 1
    inflightRef.current.clear()
    setLoading(new Set())

    if (!isTauri()) {
      setError("데스크톱 앱에서만 사용할 수 있습니다.")
      return
    }
    if (root === "") {
      // 새 프로필에는 저장소 경로가 없다 — 빈 트리를 보여 주기보다 어디서 정하는지 말한다.
      setError("설정 → Cowork 에서 저장소 경로를 지정하세요.")
      childrenRef.current = {}
      setChildren({})
      return
    }

    // 저장소가 바뀌었으면 펼침도 남길 이유가 없다(다른 저장소의 폴더 경로다).
    const rootChanged = rootRef.current !== root
    rootRef.current = root
    if (rootChanged) setExpandedSet(new Set())

    // 새로고침은 **보이는 것만** 다시 읽는다: 루트 + 펼쳐 둔 폴더. 접힌 폴더의 캐시는
    // 여기서 통째로 버려지므로(아래에서 `next` 를 새로 만든다) 다시 펼칠 때 새로 읽힌다.
    const targets = ["", ...expandedRef.current].filter(
      (rel, i, all) => all.indexOf(rel) === i
    )
    const seq = seqRef.current
    setLoading(new Set(targets))
    // 한 폴더가 사라져 실패해도 나머지는 살린다 — 하나 때문에 트리 전체가 비면 안 된다.
    const results = await Promise.allSettled(
      targets.map((rel) =>
        trackedInvoke<DevEntry[]>("dev_list_dir", { root, rel })
      )
    )
    if (seq !== seqRef.current) return

    const next: Record<string, DevEntry[]> = {}
    const failures: string[] = []
    for (let i = 0; i < targets.length; i += 1) {
      const rel = targets[i]
      const r = results[i]
      if (r.status === "fulfilled") next[rel] = r.value
      // 루트 실패는 앞에 세운다 — 사라진 하위 폴더보다 그쪽이 원인을 말해 준다.
      else if (rel === "") failures.unshift(String(r.reason))
      else failures.push(String(r.reason))
    }
    childrenRef.current = next
    setChildren(next)
    setError(failures[0] ?? null)
    setLoading(new Set())
  }, [root, setExpandedSet])

  useEffect(() => {
    // 진입/루트 변경 시 루트 목록을 읽는다(데이터 페칭 목적의 의도된 setState).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload()
  }, [reload])

  const ensure = useCallback(
    async (rel: string) => {
      if (!isTauri() || root === "") return
      if (!expandedRef.current.has(rel)) {
        const next = new Set(expandedRef.current)
        next.add(rel)
        setExpandedSet(next)
      }
      if (childrenRef.current[rel] || inflightRef.current.has(rel)) return
      await load(rel)
    },
    [load, root, setExpandedSet]
  )

  const refresh = useCallback(
    async (rel: string) => {
      if (!isTauri() || root === "") return
      if (rel !== "" && !expandedRef.current.has(rel)) {
        const next = new Set(expandedRef.current)
        next.add(rel)
        setExpandedSet(next)
      }
      await load(rel)
    },
    [load, root, setExpandedSet]
  )

  const toggle = useCallback(
    (rel: string) => {
      if (expandedRef.current.has(rel)) {
        const next = new Set(expandedRef.current)
        next.delete(rel)
        // 접어도 캐시는 남긴다 — 다시 펼치는 것이 즉시여야 트리가 무겁게 느껴지지 않는다.
        setExpandedSet(next)
        return
      }
      void ensure(rel)
    },
    [ensure, setExpandedSet]
  )

  return { children, expanded, loading, error, toggle, reload, ensure, refresh }
}
