/**
 * IntelliJ Cowork 화면 **파일 트리의 조작** — 새로 만들기 · 이름 바꾸기 · 삭제 ·
 * 잘라내기/복사/붙여넣기. IntelliJ 의 Project 툴윈도 우클릭 메뉴와 같은 묶음이다.
 *
 * 화면(`file-tree.tsx`)은 메뉴와 입력 대화창만 그리고 실제 동작은 전부 여기로 온다.
 * 그렇게 가른 이유는 **탭·버퍼와의 조율**이 이 조작의 절반이기 때문이다: 열려 있는 파일을
 * 지우거나 이름을 바꾸면 탭이 없는 파일을 가리키게 되고, 그대로 저장하면 방금 지운 파일이
 * 되살아난다. 그 판단은 트리 UI 의 몫이 아니고, 반대로 뷰(2천 줄)에 또 얹을 것도 아니다.
 *
 * 세 가지가 이 훅의 모양을 정한다:
 *
 * - **저장하지 않은 편집이 있으면 조작을 중단한다.** 지우기·이름 바꾸기·이동은 그 파일의
 *   버퍼를 무효로 만드는데, IntelliJ 처럼 편집을 따라 옮겨 주려면 버퍼의 키(절대 경로)를
 *   갈아 끼우고 탭 id 까지 바꿔야 한다. 그렇게까지 하지 않는 대신 **먼저 저장하라고 말한다** —
 *   조용히 편집을 버리는 것은 이 화면의 다른 어떤 동작도 하지 않는 일이다(탭 닫기조차 묻는다).
 *   판정과 정리는 뷰가 준 `releaseTabs` 하나가 맡는다(탭·버퍼를 아는 것은 그쪽뿐이다).
 * - **성공도 알린다.** 삭제가 휴지통으로 갔는지 영구 삭제였는지, 붙여넣기가 `사본` 이름을
 *   새로 지었는지는 결과가 화면에 그대로 보이지 않는다. Rust 가 돌려주는 그 사실을 토스트로
 *   옮긴다 — 특히 삭제는 "어디로 갔는지" 를 모르면 복구할 수 없다.
 * - **끝나면 그 폴더만 다시 읽는다.** 트리는 펼친 폴더만 캐시하므로(`use-project-tree.ts`)
 *   전체 새로고침은 펼쳐 둔 모든 폴더를 다시 읽는 낭비다. 조작한 폴더 하나(이동·붙여넣기는
 *   출발지와 도착지 둘)만 `refreshDir` 한다.
 */

import { useCallback, useState } from "react"
import { toast } from "sonner"

import { trackedInvoke } from "@/lib/tauri"
import type { DevEntry } from "./types"

/** 잘라내기/복사로 집어 둔 항목. 창이 닫히면 사라진다(디스크에 남길 값이 아니다). */
export interface DevClipboard {
  entry: DevEntry
  /** true 면 잘라내기(붙여넣으면 원본이 사라진다). */
  cut: boolean
}

/** 훅이 뷰에게 요구하는 것 — 트리 갱신, 탭 열기, 그리고 탭 정리. */
export interface FileOpsDeps {
  /** 프로젝트 루트(절대 경로). */
  root: string
  /** 이 폴더(`rel`, 루트는 "")를 강제로 다시 읽는다. */
  refreshDir: (rel: string) => void
  /** 파일 탭을 연다(새로 만든 파일·이름이 바뀐 파일) — 트리의 줄을 누른 것과 같은 길이다. */
  openEntry: (entry: DevEntry) => void
  /**
   * 이 경로(파일이면 그 파일, 폴더면 그 아래 전부)의 열린 탭과 버퍼를 놓아 준다.
   *
   * `dirty` 가 비어 있지 않으면 **아무것도 닫지 않았다**는 뜻이고, 그때 조작은 시작조차
   * 하지 않는다. `closed` 는 실제로 닫은 탭 수 — 이름 바꾸기가 "원래 열려 있던 파일이니
   * 새 이름으로 다시 열어 준다" 를 판단하는 값이다(열려 있지도 않던 파일이 이름만 바꿨다고
   * 갑자기 탭으로 열리면 안 된다).
   */
  releaseTabs: (abs: string) => { dirty: string[]; closed: number }
}

export interface FileOps {
  clipboard: DevClipboard | null
  busy: boolean
  copy: (entry: DevEntry) => void
  cut: (entry: DevEntry) => void
  /** `name` 은 `a/b/C.java` 처럼 여러 겹일 수 있다(IntelliJ 와 같다). */
  create: (parent: DirTarget, name: string, dir: boolean) => Promise<void>
  rename: (entry: DevEntry, name: string) => Promise<void>
  remove: (entry: DevEntry) => Promise<void>
  paste: (dir: DirTarget) => Promise<void>
}

/** 붙여넣기·새로 만들기의 대상 폴더. 루트는 `{ path: root, rel: "" }` 다. */
export interface DirTarget {
  path: string
  rel: string
}

/** `a/b/c.txt` → `a/b`, `a.txt` → `""`(루트). */
export function parentRel(rel: string): string {
  const i = rel.lastIndexOf("/")
  return i < 0 ? "" : rel.slice(0, i)
}

/** 항목이 든 폴더 — 새로 만들기·붙여넣기의 기준이다(파일을 우클릭했으면 그 옆). */
export function dirOf(entry: DevEntry, root: string): DirTarget {
  if (entry.dir) return { path: entry.path, rel: entry.rel }
  const i = entry.path.lastIndexOf("/")
  return {
    path: i > 0 ? entry.path.slice(0, i) : root,
    rel: parentRel(entry.rel),
  }
}

export function useFileOps({
  root,
  refreshDir,
  openEntry,
  releaseTabs,
}: FileOpsDeps): FileOps {
  const [clipboard, setClipboard] = useState<DevClipboard | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * 조작 하나를 감싼다 — 실패는 토스트로, 성공은 호출부가 정한 문구로.
   *
   * `busy` 를 여기서만 세우는 것이 요점이다 — 메뉴가 그 값으로 파일을 바꾸는 항목을 모두
   * 잠근다. 두 조작이 겹쳐 돌면 뒤엣것이 앞엣것이 만들 파일을 모르는 상태로 판단한다
   * (복사가 겹치면 `사본 2` 까지 생긴다).
   */
  const run = useCallback(
    async <T>(
      label: string,
      op: () => Promise<T>,
      done: (r: T) => void
    ): Promise<void> => {
      setBusy(true)
      try {
        done(await op())
      } catch (e) {
        toast.error(`${label} 실패`, { description: String(e).slice(0, 600) })
      } finally {
        setBusy(false)
      }
    },
    []
  )

  /**
   * 탭을 놓아 준다. 편집 중인 파일이 걸려 있으면 사유를 알리고 `null`(중단),
   * 아니면 닫은 탭 수를 돌려준다.
   */
  const release = useCallback(
    (abs: string, label: string): number | null => {
      const { dirty, closed } = releaseTabs(abs)
      if (dirty.length === 0) return closed
      toast.error(`저장하지 않은 편집이 있어 ${label} 수 없습니다`, {
        description: `${dirty.slice(0, 5).join(", ")}${
          dirty.length > 5 ? ` 외 ${dirty.length - 5}개` : ""
        } — 먼저 저장하거나 탭을 닫으세요.`,
      })
      return null
    },
    [releaseTabs]
  )

  const copy = useCallback((entry: DevEntry) => {
    setClipboard({ entry, cut: false })
  }, [])

  const cut = useCallback((entry: DevEntry) => {
    setClipboard({ entry, cut: true })
  }, [])

  const create = useCallback(
    async (parent: DirTarget, name: string, dir: boolean) => {
      await run(
        dir ? "폴더 만들기" : "파일 만들기",
        () =>
          trackedInvoke<DevEntry>("dev_create_entry", {
            root,
            parent: parent.path,
            name,
            dir,
          }),
        (made) => {
          refreshDir(parent.rel)
          // 여러 겹 이름(`a/b/C.java`)이면 실제로 담긴 폴더는 우클릭한 곳이 아니라 그
          // 안쪽이다. `refreshDir` 는 접힌 폴더를 펼치므로, 그쪽까지 읽어야 방금 만든
          // 것이 눈에 보인다(중간 폴더는 이번에 새로 생겼을 수도 있다).
          const deep = parentRel(made.rel)
          if (deep !== parent.rel) refreshDir(deep)
          // 만든 파일은 바로 연다 — 새로 만드는 이유가 거기에 쓰려는 것이다.
          // 폴더는 열 것이 없으므로 트리 갱신만 한다.
          if (!made.dir) openEntry(made)
        }
      )
    },
    [run, root, refreshDir, openEntry]
  )

  const rename = useCallback(
    async (entry: DevEntry, name: string) => {
      if (name.trim() === entry.name) return
      // 이름이 바뀌면 그 파일의 버퍼 키(절대 경로)가 무효가 되므로 탭을 먼저 놓아 준다.
      // 닫은 탭이 있었다면 새 이름으로 다시 열어 준다 — IntelliJ 도 탭을 그대로 둔다.
      // **폴더의 이름을 바꾼 경우는 그 안의 탭들이 닫힌 채로 남는다**: 새 경로를 하나하나
      // 다시 열어 주려면 닫은 목록을 들고 와 경로를 갈아 끼워야 하는데, 그 값은 뷰의 탭
      // 모델에만 있고 여기서 필요한 것은 "지운 파일을 가리키는 탭이 없다" 하나다.
      const closed = release(entry.path, "이름을 바꿀")
      if (closed === null) return
      await run(
        "이름 바꾸기",
        () =>
          trackedInvoke<DevEntry>("dev_rename_entry", {
            root,
            path: entry.path,
            name,
          }),
        (moved) => {
          refreshDir(parentRel(entry.rel))
          if (!moved.dir && closed > 0) openEntry(moved)
        }
      )
    },
    [run, root, refreshDir, openEntry, release]
  )

  const remove = useCallback(
    async (entry: DevEntry) => {
      if (release(entry.path, "삭제할") === null) return
      await run(
        "삭제",
        () =>
          trackedInvoke<boolean>("dev_delete_entry", {
            root,
            path: entry.path,
          }),
        (trashed) => {
          refreshDir(parentRel(entry.rel))
          // 어디로 갔는지가 곧 복구 가능성이다 — 반드시 구분해서 말한다.
          toast.success(
            trashed
              ? `휴지통으로 옮겼습니다: ${entry.name}`
              : `영구 삭제했습니다: ${entry.name}`,
            trashed
              ? undefined
              : { description: "휴지통으로 옮길 수 없어 바로 지웠습니다." }
          )
        }
      )
    },
    [run, root, refreshDir, release]
  )

  const paste = useCallback(
    async (dir: DirTarget) => {
      const clip = clipboard
      if (!clip) return
      // 잘라내기는 원본이 사라지므로 그 파일의 탭을 먼저 놓아 준다. 복사는 원본이 그대로라
      // 건드릴 이유가 없다 — 편집 중이어도 붙여넣기는 안전하다(디스크의 내용이 복사된다는
      // 점은 저장 안 한 편집과 무관하게 언제나 참이다).
      if (clip.cut && release(clip.entry.path, "옮길") === null) return
      await run(
        clip.cut ? "이동" : "복사",
        () =>
          trackedInvoke<DevEntry>(
            clip.cut ? "dev_move_entry" : "dev_copy_entry",
            { root, src: clip.entry.path, destDir: dir.path }
          ),
        (made) => {
          refreshDir(dir.rel)
          // 이동은 출발지도 바뀐다. 같은 폴더면 두 번 읽지 않는다.
          const from = parentRel(clip.entry.rel)
          if (clip.cut && from !== dir.rel) refreshDir(from)
          // 잘라내기는 한 번 붙이면 소진된다(원본이 이미 없어서 두 번째는 실패한다).
          if (clip.cut) setClipboard(null)
          // 이름이 겹쳐 `사본` 이 붙은 경우에만 결과를 알린다 — 그대로 들어갔으면 트리에
          // 보이는 것이 곧 결과이므로 토스트가 소음이다.
          if (made.name !== clip.entry.name)
            toast.success(`${made.name} 으로 붙여넣었습니다`, {
              description: "같은 이름이 이미 있어 새 이름을 만들었습니다.",
            })
        }
      )
    },
    [run, root, refreshDir, release, clipboard]
  )

  return { clipboard, busy, copy, cut, create, rename, remove, paste }
}
