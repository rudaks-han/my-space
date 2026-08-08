/**
 * IntelliJ Cowork 화면의 **파일 버퍼** — 절대 경로 하나당 편집 상태 하나.
 *
 * 탭이 여러 개 열려 있어도 고치던 내용을 잃지 않는 것이 이 훅의 전부다. IDE 처럼
 * 다른 탭을 눌렀다 돌아와도 커서 앞의 글자가 그대로 있어야 하므로, 탭을 옮길 때마다
 * 파일을 다시 읽는 대신 경로별 버퍼를 들고 있는다. 그래서 `load` 는 **멱등**이다 —
 * 루트가 탭이 활성화될 때마다 부르지만 이미 있는 버퍼는 건드리지 않는다.
 *
 * **파일 시스템을 감시하지 않는다.** 폴링도 `notify` 도 없다: 이 화면은 자기가 쓴
 * 파일만 보는 편집기이고, 밖에서(git checkout, 다른 IDE) 바뀐 내용을 자동으로 덮어
 * 쓰면 저장 안 한 편집을 예고 없이 날린다. 디스크 쪽이 최신이라고 판단하는 것은
 * 사람이므로, 다시 읽는 것도 사람이 시킨다 — 툴바의 **새로고침**이 지금 보고 있는
 * 파일에 `load(path, true)` 를 걸어 디스크 내용으로 되돌린다(그때는 편집이 버려지므로
 * 루트가 `dirty(path)` 로 먼저 물어봐야 한다).
 */

import { useCallback, useEffect, useRef, useState } from "react"

import { isTauri, trackedInvoke } from "@/lib/tauri"
import type { DevFileText } from "./types"

/** 열려 있는 파일 하나의 편집 상태. */
export interface Buffer {
  /** 편집 중인 원문. */
  text: string
  /** 마지막으로 읽거나 저장한 원문 — 수정 여부(`dirty`)의 판정 기준. */
  saved: string
  loading: boolean
  /**
   * 디스크에서 **한 번이라도 제대로 읽었는지.**
   *
   * 읽기가 실패해도 버퍼는 만들어진다(실패 사유를 담아야 하므로). 그런데 그 버퍼는
   * `text`·`saved` 가 빈 문자열이라 "빈 파일"과 구분이 안 되고, 그대로 편집기를 띄우면
   * 사용자가 타자를 친 뒤 ⌘S 로 **원래 파일을 그 몇 글자로 덮어쓴다**(파일만 이름이
   * 바뀐 경우 저장은 성공한다). 화면은 이 값이 false 면 편집기 대신 오류를 그리고,
   * `save` 는 아예 거절한다.
   */
  loaded: boolean
  /** 읽기·저장 실패, 그리고 "저장할 수 없는 파일"이라는 거절 사유. */
  error: string | null
  /** 텍스트가 아니다(NUL 바이트) — 편집기 대신 안내를 띄우고 저장을 막는다. */
  binary: boolean
  /** 2MB 제한에 걸려 앞부분만 읽었다 — 되쓰면 나머지가 지워지므로 저장을 막는다. */
  truncated: boolean
  size: number
}

const inTauri = isTauri()

const BLANK: Buffer = {
  text: "",
  saved: "",
  loading: false,
  loaded: false,
  error: null,
  binary: false,
  truncated: false,
  size: 0,
}

/** 저장을 거절하는 두 경우의 사유 — 버퍼의 `error` 로 그대로 보여 준다. */
function refuseReason(b: Buffer): string | null {
  if (b.binary) return "텍스트 파일이 아니라 편집·저장할 수 없습니다."
  if (b.truncated)
    return "2MB 가 넘어 앞부분만 읽었습니다 — 그대로 저장하면 나머지가 지워지므로 저장할 수 없습니다."
  return null
}

export function useFileBuffers(root: string) {
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({})
  const [saving, setSaving] = useState<Set<string>>(new Set())

  /*
   * 같은 표를 ref 에도 들고 간다. 그래야 `load` / `save` 의 의존성이 `root` 뿐이라
   * 함수 정체성이 안정된다 — 루트는 탭이 활성화될 때마다 효과 안에서 `load` 를
   * 부르므로, 버퍼가 바뀔 때마다 함수가 새로 만들어지면 그 효과가 다시 돌면서
   * 방금 읽은 파일을 끝없이 다시 읽는다(IntelliJ HTTP 뷰가 겪은 그 문제다).
   */
  const ref = useRef(buffers)

  const apply = useCallback(
    (fn: (prev: Record<string, Buffer>) => Record<string, Buffer>) => {
      const next = fn(ref.current)
      if (next === ref.current) return
      ref.current = next
      setBuffers(next)
    },
    []
  )

  const setError = useCallback(
    (path: string, error: string | null) => {
      apply((prev) => {
        const cur = prev[path]
        if (!cur || cur.error === error) return prev
        return { ...prev, [path]: { ...cur, error } }
      })
    },
    [apply]
  )

  /**
   * 파일을 읽어 버퍼를 만든다. 이미 있으면 **아무것도 하지 않는다**(저장 안 한 편집을
   * 지키기 위한 규칙이다). `force` 는 툴바의 새로고침 전용 — 디스크 내용으로 되돌린다.
   */
  const load = useCallback(
    async (path: string, force = false) => {
      if (!inTauri || !path) return
      const cur = ref.current[path]
      if (cur?.loading) return // 같은 파일을 두 번 읽지 않는다
      // 읽기에 실패해 남은 버퍼는 다시 시도한다 — 그러지 않으면 트리에서 같은 파일을
      // 다시 눌러도 조용히 아무 일도 일어나지 않는다(이펙트 의존성은 그대로라 무한
      // 재시도가 되지도 않는다).
      if (cur?.loaded && !force) return

      apply((prev) => ({
        ...prev,
        [path]: { ...(prev[path] ?? BLANK), loading: true, error: null },
      }))
      try {
        const f = await trackedInvoke<DevFileText>("dev_read_file", {
          root,
          path,
        })
        const next: Buffer = {
          text: f.text,
          saved: f.text,
          loading: false,
          loaded: true,
          error: null,
          binary: f.binary,
          truncated: f.truncated,
          size: f.size,
        }
        apply((prev) => ({
          ...prev,
          [path]: { ...next, error: refuseReason(next) },
        }))
      } catch (e) {
        apply((prev) => ({
          ...prev,
          [path]: {
            ...(prev[path] ?? BLANK),
            loading: false,
            error: String(e),
          },
        }))
      }
    },
    [root, apply]
  )

  const setText = useCallback(
    (path: string, text: string) => {
      apply((prev) => {
        const cur = prev[path]
        // 버퍼가 없는 경로는 아직 열리는 중이다 — 빈 버퍼를 만들어 두면 그 파일이
        // 통째로 빈 내용으로 저장될 수 있다.
        if (!cur || cur.text === text) return prev
        return { ...prev, [path]: { ...cur, text } }
      })
    },
    [apply]
  )

  /**
   * 디스크에 쓴다. **반쯤 읽은 파일과 바이너리는 거절한다** — 우리가 읽은 앞부분만
   * 되쓰면 나머지가 조용히 지워지므로, 실패를 버퍼의 `error` 로 드러낸다.
   */
  const save = useCallback(
    async (path: string) => {
      const buf = ref.current[path]
      if (!buf || buf.loading) return
      // 읽지 못한 파일은 되쓰지 않는다 — 화면의 빈 편집기는 "빈 파일"이 아니라
      // "못 읽었다"이고, 그대로 저장하면 원본을 몇 글자로 덮어쓴다.
      if (!buf.loaded) {
        setError(
          path,
          buf.error ?? "파일을 읽지 못해 저장할 수 없습니다. 새로고침하세요."
        )
        return
      }
      const refuse = refuseReason(buf)
      if (refuse) {
        setError(path, refuse)
        return
      }
      if (!inTauri) {
        setError(path, "데스크톱 앱에서만 저장할 수 있습니다.")
        return
      }
      if (buf.text === buf.saved) return

      // 저장하는 동안에도 타자를 칠 수 있으므로, 기준선은 "지금 화면의 글자"가 아니라
      // **실제로 써 보낸 글자**여야 한다. cur.text 로 맞추면 그 사이의 편집이
      // 저장된 것으로 둔갑해 수정 표시가 사라진다.
      const text = buf.text
      setSaving((prev) => new Set(prev).add(path))
      try {
        await trackedInvoke<void>("dev_write_file", { root, path, text })
        apply((prev) => {
          const cur = prev[path]
          if (!cur) return prev
          return { ...prev, [path]: { ...cur, saved: text, error: null } }
        })
      } catch (e) {
        setError(path, String(e))
      } finally {
        setSaving((prev) => {
          if (!prev.has(path)) return prev
          const next = new Set(prev)
          next.delete(path)
          return next
        })
      }
    },
    [root, apply, setError]
  )

  const dirty = useCallback(
    (path: string) => {
      const b = buffers[path]
      return !!b && b.text !== b.saved
    },
    [buffers]
  )

  /**
   * 버퍼를 버린다(탭이 닫혔다).
   *
   * 수정 중인 버퍼는 `force` 없이는 **버리지 않고 `false` 를 돌려준다** — 확인 창을
   * 여기서 띄우지 않는 이유는 이 훅이 화면을 모르기 때문이고, 그렇다고 조용히
   * 버리면 탭의 X 한 번에 편집이 사라진다. 루트는 `dirty(path)` 로 먼저 물어본 뒤
   * `close(path, true)` 로 다시 부른다.
   */
  const close = useCallback(
    (path: string, force = false) => {
      const cur = ref.current[path]
      if (!cur) return true
      if (!force && cur.text !== cur.saved) return false
      apply((prev) => {
        if (!prev[path]) return prev
        const next = { ...prev }
        delete next[path]
        return next
      })
      return true
    },
    [apply]
  )

  /*
   * 프로젝트 루트가 바뀌면 이전 루트의 버퍼는 다른 저장소의 파일이라 대체로 의미가 없다 —
   * **저장하지 않은 편집만 남기고** 나머지는 버린다(깨끗한 버퍼는 디스크에서 다시 읽으면
   * 그만이다).
   *
   * 왜 통째로 비우지 않는가: 이 값의 출처인 설정 → Cowork 의 경로 칸은 **입력 상자**라
   * 타자 한 글자마다 루트가 바뀐다. 전부 비우면 그 경로를 고쳐 쓰는 동작만으로 편집 중인
   * 내용이 예고 없이 사라진다 — 이 화면의 다른 모든 파괴적 동작(탭 닫기·새로고침)은
   * 먼저 물어보거나 수정 중인 파일을 건드리지 않는데, 여기만 조용히 지운다면 그게 버그다.
   * 버퍼 키는 절대 경로라 남겨 둬도 어긋나지 않고, 새 루트 밖이면 저장이 거절되며 그
   * 사유가 화면의 띠에 뜬다(경로를 되돌리면 그대로 저장된다).
   *
   * 첫 렌더에서는 돌지 않도록 이전 값을 ref 로 들고 비교한다.
   */
  const rootRef = useRef(root)
  useEffect(() => {
    if (rootRef.current === root) return
    rootRef.current = root
    const keep: Record<string, Buffer> = {}
    for (const [path, b] of Object.entries(ref.current)) {
      if (b.text !== b.saved) keep[path] = b
    }
    ref.current = keep
    // 루트 교체에 따른 의도된 정리다(탭은 닫지 않는다 — 열 수 없게 된 탭은 화면이
    // 사유와 함께 닫기 버튼을 내보내고, 지우는 판단은 사용자가 한다).
    setBuffers(keep)
    setSaving(new Set())
  }, [root])

  return { buffers, load, setText, save, close, dirty, saving }
}
