import { useCallback } from "react"

import { useLocalStorage } from "@/lib/use-local-storage"

/** 포스트잇에 지정된 실행 세션. */
export interface RunTarget {
  /** herdr 세션 이름(명령 라우팅용). cmux/Orca 는 "cmux"/"orca". */
  session: string
  workspaceId: string
  /** 지정 당시의 워크스페이스 이름. 목록에서 사라졌을 때 무엇을 골랐던 것인지 알리는 데만 쓴다. */
  label: string
}

/**
 * 포스트잇 → 실행 세션 매핑.
 *
 * **마크다운 파일(포스트잇 frontmatter)이 아니라 localStorage 에 따로 둔다.** 워크스페이스
 * id 는 터미널이 살아 있는 동안만 유효한 런타임 값이라(herdr 를 다시 띄우면 `w1` 이 다른
 * 작업을 가리킨다) 기기 사이에서 공유되는 볼트 파일에 넣으면 다른 기기에서는 아무 의미가
 * 없고, 최악의 경우 **엉뚱한 세션을 가리킨다**. `hideDone` 과 같은 "이 기기에서의 보기
 * 설정" 계열이다. 덕분에 `use-todo-folder-sync` 의 지문·필드 규칙도 건드리지 않는다.
 *
 * ⚠️ **호출은 뷰에서 한 번만.** 같은 창에서 같은 키로 `useLocalStorage` 를 두 번 부르면
 * 서로의 쓰기를 보지 못해(`storage` 이벤트는 다른 창에만 간다) 카드 A 의 지정이 카드 B 의
 * 낡은 스냅샷에 덮여 사라진다. 그래서 `TodoView` 가 한 번 부르고 카드에 내려 준다.
 */
export function useRunSessions() {
  const [map, setMap] = useLocalStorage<Record<string, RunTarget>>(
    "myspace.todoRunSessions",
    {}
  )

  const targetOf = useCallback(
    (noteId: string): RunTarget | null => map[noteId] ?? null,
    [map]
  )

  const setTarget = useCallback(
    (noteId: string, target: RunTarget | null) => {
      setMap((prev) => {
        if (!target) {
          if (!(noteId in prev)) return prev
          const next = { ...prev }
          delete next[noteId]
          return next
        }
        return { ...prev, [noteId]: target }
      })
    },
    [setMap]
  )

  return { targetOf, setTarget }
}

export type RunSessions = ReturnType<typeof useRunSessions>

/**
 * 작업 폴더 표시용 축약. 한 줄에 다 들어가지 않을 때 잘려 나가는 쪽이 **뒤**(리포 이름)라
 * truncate 에만 맡기면 정작 어느 프로젝트인지가 사라진다. 그래서 앞을 먼저 줄인다.
 */
export function shortPath(cwd: string): string {
  const home = cwd.replace(/^\/Users\/[^/]+/, "~")
  const parts = home.split("/").filter(Boolean)
  return parts.length <= 3 ? home : `…/${parts.slice(-2).join("/")}`
}

/**
 * 할 일 → 프롬프트 초안. 포스트잇 제목을 앞에 붙이는 이유는 할 일 문구가 짧아서다
 * ("버전 올리기" 만으로는 무엇의 버전인지 알 수 없다). 제목이 비어 있으면 붙일 맥락이
 * 없으니 그대로 둔다.
 */
export function draftPrompt(noteTitle: string, todoText: string): string {
  const title = noteTitle.trim()
  const text = todoText.trim()
  return title ? `${title}: ${text}` : text
}
