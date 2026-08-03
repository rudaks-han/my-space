import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { isTauri, trackedInvoke } from "@/lib/tauri"
import { useSettings } from "@/features/settings/settings-context"
import { useTabActive } from "@/lib/use-tab-active"
import type { StickyCategory, StickyNote, StickyColor } from "./use-todos"

/**
 * 할 일 보드를 **폴더 안의 마크다운 파일**과 양방향으로 맞춘다(설정 → 할 일).
 *
 * 큰 규칙 하나: **localStorage 를 대체하지 않고 캐시로 남긴다.** 파일을 직접 상태로 쓰면
 * (1) 폴더가 없는 기본 사용자를 위해 두 갈래 코드를 유지해야 하고, (2) 타이핑마다 파일
 * 왕복을 기다리게 되고, (3) 팝아웃 창과 메인 창이 `storage` 이벤트로 공유하던 상태가
 * 갈린다. 그래서 진실의 사본은 계속 localStorage 이고, 이 훅은 그 위에 얹는 동기화층이다 —
 * 폴더가 비어 있으면 하는 일이 하나도 없다(기본 동작이 그대로 남는다).
 *
 * 변화 감지는 **mtime 폴링**이다. `notify` 크레이트를 붙이지 않는 이유는 감시 대상이
 * 카테고리 수만큼(보통 몇 개)뿐이라 `read_dir` 이 무시할 만큼 싸고, 이 코드베이스의 다른
 * 감시가 모두 폴링이라는 것(herdr 800ms, gcal 5분)이다. 그리고 keep-alive 규칙대로
 * `useTabActive()` 로 게이트한다 — 탭이 열려 있는 모든 뷰가 동시에 폴링하면 안 된다.
 *
 * 되읽기 왕복을 막는 장치가 두 개다:
 *  - **지문(signature)**: 쓰기가 끝나면 Rust 가 그 직후의 mtime 지문을 돌려주고, 폴링은
 *    지문이 그것과 같으면 아무 일도 하지 않는다. 없으면 우리가 쓴 파일을 우리가 다시 읽어
 *    상태를 갱신하고, 그 갱신이 다시 쓰기를 부르는 무한 왕복이 된다.
 *  - **내용 지문(fingerprint)**: 파일에 실제로 반영되는 필드만 이어 붙인 문자열이다.
 *    `createdAt` 처럼 파일에 적히지 않는 값이 바뀌었을 때 쓸데없이 파일을 건드리지 않고,
 *    무엇보다 파일에서 읽어 온 직후에 곧바로 되쓰는 일을 막는다.
 *
 * 창이 여러 개일 때(팝아웃) **`isMainWindow` 로 막지 않는다.** 이 훅은 전역 스케줄러가
 * 아니라 할 일 뷰에 딸린 것이라, 메인 창에 할 일 탭이 없고 팝아웃만 열려 있으면 아무도
 * 동기화하지 않게 된다. 두 창이 같은 내용을 두 번 쓰는 건 결과가 같아(멱등) 무해하다.
 */

/** 폴더 변화를 확인하는 주기. */
const POLL_MS = 2000
/** 타이핑이 멈춘 뒤 파일에 반영할 때까지 기다리는 시간. */
const PUSH_DEBOUNCE_MS = 500

/** 파일에 실제로 저장되는 만큼의 보드(동기화 단위). */
export interface TodoBoard {
  categories: StickyCategory[]
  notes: StickyNote[]
  trash: StickyNote[]
}

/** Rust 가 돌려주는 포스트잇(파일에 적힌 것만). */
interface RemoteNote {
  id: string
  title: string
  color: string
  categoryId: string
  todos: { text: string; done: boolean }[]
  deletedAt?: number
}

interface RemoteSnapshot {
  categories: StickyCategory[]
  notes: RemoteNote[]
  trash: RemoteNote[]
  signature: string
  /** 폴더에 우리가 관리하는 파일이 하나라도 있었는지. */
  populated: boolean
}

const COLORS: StickyColor[] = [
  "yellow",
  "pink",
  "green",
  "blue",
  "purple",
  "gray",
]

function newId() {
  return crypto.randomUUID()
}

function asColor(raw: string): StickyColor {
  return (COLORS as string[]).includes(raw) ? (raw as StickyColor) : "yellow"
}

/**
 * 파일에 반영되는 필드만 뽑은 지문. 배열 순서가 그대로 들어가므로 포스트잇·카테고리
 * 순서를 바꾼 것도 변경으로 잡힌다(파일의 순서와 `order:` 가 그 순서를 담는다).
 */
function fingerprint(board: TodoBoard): string {
  return JSON.stringify([
    board.categories.map((c) => [c.id, c.name]),
    board.notes.map((n) => [
      n.id,
      n.title,
      n.color,
      n.categoryId,
      n.todos.map((t) => [t.text, t.done]),
    ]),
    board.trash.map((n) => [
      n.id,
      n.title,
      n.color,
      n.categoryId,
      n.deletedAt ?? 0,
      n.todos.map((t) => [t.text, t.done]),
    ]),
  ])
}

/**
 * 파일에서 읽은 포스트잇을 앱 모델로 옮긴다. 파일에 없는 값은 여기서 만든다:
 * `id` 는 사람이 Obsidian 에서 직접 `## 제목` 을 추가했을 때 비어 있고(그때 새로 만들어
 * 두면 다음 저장에서 파일에 적힌다), `createdAt` 은 화면에서 쓰이지 않아 파일에 적지
 * 않으므로 읽는 시점 값을 채운다.
 */
function toStickyNote(r: RemoteNote, now: number): StickyNote {
  return {
    id: r.id || newId(),
    title: r.title,
    color: asColor(r.color),
    categoryId: r.categoryId,
    createdAt: now,
    todos: r.todos.map((t) => ({
      id: newId(),
      text: t.text,
      done: t.done,
      createdAt: now,
    })),
    ...(r.deletedAt !== undefined ? { deletedAt: r.deletedAt } : {}),
  }
}

/**
 * 스냅샷 전체를 앱 모델로 옮긴다.
 *
 * 카테고리 id 는 여기서 손대지 않는다 — Rust 가 파일명으로 채워서 보내므로 늘 채워져
 * 있고, 포스트잇의 `categoryId` 가 그 값을 참조하기 때문에 프론트에서 새로 만들면
 * 참조가 어긋난다.
 */
function toBoard(snap: RemoteSnapshot): TodoBoard {
  const now = Date.now()
  return {
    categories: snap.categories,
    notes: snap.notes.map((r) => toStickyNote(r, now)),
    trash: snap.trash.map((r) => toStickyNote(r, now)),
  }
}

/** Rust 로 보낼 모양으로 줄인다(파일에 적히지 않는 필드는 보내지 않는다). */
function toPayload(board: TodoBoard) {
  const note = (n: StickyNote) => ({
    id: n.id,
    title: n.title,
    color: n.color,
    categoryId: n.categoryId,
    todos: n.todos.map((t) => ({ text: t.text, done: t.done })),
    ...(n.deletedAt !== undefined ? { deletedAt: n.deletedAt } : {}),
  })
  return {
    categories: board.categories.map((c) => ({ id: c.id, name: c.name })),
    notes: board.notes.map(note),
    trash: board.trash.map(note),
  }
}

export interface TodoFolderSync {
  /** 설정된 폴더(빈 문자열이면 파일 저장을 하지 않는다). */
  folder: string
  /** 마지막 읽기/쓰기가 실패한 이유. 성공하면 비워진다. */
  error: string
  /** 첫 읽기가 끝났는지. 끝나기 전에는 파일에 쓰지 않는다. */
  ready: boolean
}

/**
 * @param board  현재 보드(localStorage 에 있는 값)
 * @param apply  파일에서 읽어 온 보드를 상태에 반영하는 콜백
 */
export function useTodoFolderSync(
  board: TodoBoard,
  apply: (next: TodoBoard) => void
): TodoFolderSync {
  const { settings } = useSettings()
  const folder = settings.todo.folder.trim()
  const tabActive = useTabActive()
  const enabled = folder !== "" && isTauri()

  const [error, setError] = useState("")
  /**
   * 첫 맞춤이 끝난 폴더. `ready` 를 따로 두지 않고 **어느 폴더에 대해 준비됐는지**를
   * 담는 이유는 폴더가 바뀔 때 `setReady(false)` 를 이펙트 본문에서 불러야 하기 때문이다
   * (`react-hooks/set-state-in-effect` 위반이자 불필요한 렌더). 값을 비교하면 폴더가
   * 바뀌는 순간 저절로 준비 안 된 상태가 된다.
   */
  const [readyFor, setReadyFor] = useState("")
  const ready = !enabled || readyFor === folder

  // 최신 값을 타이머/비동기 콜백에서 읽기 위한 참조들. 렌더 중에는 손대지 않는다
  // (`react-hooks/refs`) — 갱신은 이펙트에서 하고, 읽는 곳은 모두 렌더 밖이다.
  const boardRef = useRef(board)
  const applyRef = useRef(apply)
  useEffect(() => {
    boardRef.current = board
    applyRef.current = apply
  }, [board, apply])

  /** 마지막으로 우리가 확인한 폴더 지문. 폴링이 이 값과 비교한다. */
  const sigRef = useRef("")
  /** 마지막으로 파일과 일치한다고 확인된 내용 지문. */
  const syncedRef = useRef("")
  /** 읽기/쓰기가 진행 중인 동안 폴링을 쉬게 한다(중간 상태를 읽지 않도록). */
  const busyRef = useRef(false)

  const mark = useCallback((next: TodoBoard, signature: string) => {
    syncedRef.current = fingerprint(next)
    sigRef.current = signature
  }, [])

  /**
   * 파일 → 앱. **파일이 하나도 없으면 상태를 건드리지 않는다.**
   *
   * 이 조건이 없으면 데이터가 쌓인 보드에 빈 폴더를 지정하는 순간 보드가 비워지고,
   * 폴더가 잠깐 사라지는 상황(외장 디스크 분리, Dropbox 재동기화, 볼트 이동)마다 같은
   * 일이 벌어진다. 파일이 전부 없어진 것은 사고일 가능성이 높으므로 **지우는 방향으로는
   * 자동 반영하지 않는다** — 진짜 비우고 싶으면 앱에서 지우면 그게 파일로 나간다.
   *
   * 그때도 지문은 갱신해 둔다. 안 하면 폴링이 매 주기마다 같은 빈 폴더를 다시 읽는다.
   */
  const pull = useCallback(async () => {
    const snap = await trackedInvoke<RemoteSnapshot>("todo_folder_read", {
      folder,
    })
    if (!snap.populated) {
      sigRef.current = snap.signature
      return snap
    }
    const next = toBoard(snap)
    mark(next, snap.signature)
    applyRef.current(next)
    return snap
  }, [folder, mark])

  /** 앱 → 파일. */
  const push = useCallback(async () => {
    const current = boardRef.current
    const signature = await trackedInvoke<string>("todo_folder_write", {
      folder,
      ...toPayload(current),
    })
    mark(current, signature)
  }, [folder, mark])

  // 폴더가 정해지거나 바뀌면 한 번 맞춘다.
  //
  // 방향은 폴더 상태가 정한다: 이미 우리 파일이 있으면 **파일이 이긴다**(다른 기기나
  // Obsidian 에서 쌓아 둔 것을 방금 켠 앱의 빈 보드로 덮어쓰면 안 된다), 비어 있으면
  // 지금 보드를 내보낸다(처음 연결하는 경우).
  useEffect(() => {
    sigRef.current = ""
    syncedRef.current = ""
    if (!enabled) return
    let alive = true
    busyRef.current = true
    void (async () => {
      try {
        const snap = await pull()
        if (!alive) return
        if (!snap.populated) await push()
        if (!alive) return
        setError("")
      } catch (e) {
        if (!alive) return
        setError(String(e))
      } finally {
        busyRef.current = false
        // 실패해도 준비된 것으로 표시한다. 안 하면 경로를 잘못 적었을 때 아래 파일 저장이
        // 영구히 멈춘 채로 남고, `use-todos` 의 기본 카테고리 생성도 막혀 화면이 빈다.
        if (alive) setReadyFor(folder)
      }
    })()
    return () => {
      alive = false
    }
  }, [enabled, folder, pull, push])

  // 보드가 바뀌면 파일에 반영한다(타이핑이 멈춘 뒤).
  const local = useMemo(() => fingerprint(board), [board])
  useEffect(() => {
    if (!enabled || !ready) return
    if (local === syncedRef.current) return // 파일과 이미 같다.
    const timer = setTimeout(() => {
      busyRef.current = true
      void push()
        .then(() => setError(""))
        .catch((e) => setError(String(e)))
        .finally(() => {
          busyRef.current = false
        })
    }, PUSH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [enabled, ready, local, push])

  // 외부(Obsidian 등)에서 파일을 고쳤는지 지문만 싸게 확인한다.
  // keep-alive 규칙대로 탭이 실제로 보일 때만 돈다.
  useEffect(() => {
    if (!enabled || !ready || !tabActive) return
    const tick = async () => {
      if (busyRef.current) return
      try {
        const sig = await trackedInvoke<string>("todo_folder_signature", {
          folder,
        })
        if (sig === sigRef.current) return // 우리가 쓴 그대로다.
        busyRef.current = true
        try {
          await pull()
          setError("")
        } finally {
          busyRef.current = false
        }
      } catch (e) {
        setError(String(e))
      }
    }
    // 탭으로 돌아온 직후를 기다리게 하지 않는다(가장 흔한 시나리오가
    // "Obsidian 에서 체크하고 앱으로 돌아옴"이다).
    void tick()
    const timer = setInterval(() => void tick(), POLL_MS)
    return () => clearInterval(timer)
  }, [enabled, ready, tabActive, folder, pull])

  // 폴더를 해제하면 남아 있던 오류 표시도 함께 사라져야 한다(이펙트에서 지우면
  // 불필요한 렌더가 한 번 더 생기므로 반환할 때 걸러 낸다).
  return { folder, error: enabled ? error : "", ready }
}
