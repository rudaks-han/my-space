/**
 * 프로젝트 트리를 git 상태로 물들이기 위한 조회표.
 *
 * IntelliJ 의 Project 뷰가 하는 일과 같다 — **아이콘은 파일 종류, 이름 색은 VCS 상태**.
 * 두 신호를 한 줄(22px)에 겹쳐도 읽히는 이유가 그 분리라서, 여기서 만드는 것은
 * "이름에 붙일 색" 하나뿐이고 아이콘은 건드리지 않는다.
 *
 * 왜 `Map` 하나를 새로고침마다 통째로 다시 만드는가: 트리는 한 겹씩 지연 로딩되므로
 * "지금 화면에 어떤 경로가 있는지"를 이쪽에서 알 수 없다. 변경된 파일 수(보통 수십 개)에
 * 비례해 표를 만들어 두고 각 줄이 자기 경로로 한 번 조회하는 편이, 줄마다 변경 목록을
 * 훑는 것보다 훨씬 싸다. 표를 새로 만들면 identity 가 바뀌어 모든 줄이 리렌더되지만,
 * 새로고침은 **수동**(툴바 버튼)이라 사용자가 누른 순간에만 일어난다 — 폴링이 아니다.
 */

import type { GitChange, GitStatus } from "@/features/git/git-client"

/**
 * 트리에서 구분하는 상태. porcelain 의 일곱 글자를 다섯 가지로 줄인 것인데,
 * 줄일 수 있는 근거는 색이 다섯 개뿐이라는 것이다 — R(이름 변경)·C(복사)·T(형식 변경)은
 * 모두 "추적 중인데 뭔가 바뀌었다"라서 `modified` 와 같은 색을 쓴다.
 */
export type GitMark =
  "added" | "modified" | "deleted" | "untracked" | "conflict"

/**
 * 폴더로 굴려 올릴 때의 우선순위. 충돌이 가장 급하고, 추적 중인 변경이 그다음,
 * 버전 관리 밖의 파일이 가장 약하다.
 *
 * 추적 중인 세 가지(`modified`/`added`/`deleted`)가 **같은 등급**인 것은 의도다 —
 * 폴더에서는 어차피 `modified` 하나로 합쳐지므로 서로 이길 필요가 없고, 등급을 가르면
 * 파일 순서에 따라 결과가 달라지는 것처럼 보인다.
 */
const RANK: Record<GitMark, number> = {
  conflict: 4,
  modified: 3,
  added: 3,
  deleted: 3,
  untracked: 2,
}

/**
 * 표를 만들지 않고 포기하는 지점.
 *
 * 무시 규칙이 아직 산출물을 못 덮은 갓 클론한 저장소에서는 변경 목록이 수만 줄이 될 수
 * 있는데, 그때 표를 만드는 비용보다 **그 표를 들고 리렌더되는 트리**가 문제다. 색이 없는
 * 트리는 여전히 쓸 수 있지만 멈춘 창은 쓸 수 없으므로, 이 선을 넘으면 빈 표를 준다.
 */
const MAX_ENTRIES = 20_000

/** 파일 하나의 상태. `changeMark()` 와 같은 판정 순서를 쓰되 색 단위로 접는다. */
function markOfFile(c: GitChange): GitMark {
  if (c.conflict) return "conflict"
  // 추적되지 않는 파일은 `status.untracked` 로 따로 오지만, 이 판정을 여기 남겨 두면
  // 두 배열을 하나로 이어 붙여 돌 수 있다.
  if (c.untracked) return "untracked"
  // 인덱스(X)가 비어 있을 때만 작업 트리(Y)를 본다 — 변경 목록과 같은 규칙.
  switch (c.index !== " " ? c.index : c.worktree) {
    case "A":
      return "added"
    case "D":
      return "deleted"
    default:
      // M·R·C·T, 그리고 알 수 없는 글자까지 — "추적 중인데 바뀌었다"로 모은다.
      return "modified"
  }
}

/**
 * 폴더에 얹을 색. 추적 중인 세 상태를 전부 `modified` 로 접는다.
 *
 * IntelliJ 가 그렇게 한다: 폴더는 안에 추적 중인 변경이 하나라도 있으면 파랑이고,
 * 버전 관리 밖의 색은 **안에 그것만 있는** 폴더에 남겨 둔다. 그래야 파란 폴더를 따라
 * 내려가면 커밋할 것이 나오고, 빨간 폴더는 "아직 git 이 모르는 것들"로 읽힌다.
 */
function folderMark(mark: GitMark): GitMark {
  return mark === "conflict" || mark === "untracked" ? mark : "modified"
}

/**
 * 변경 목록 → `절대 경로` → 색 표. 파일과 **합성된 조상 폴더**를 함께 담는다.
 *
 * **키가 절대 경로인 것이 이 함수의 핵심이다.** git 이 주는 경로는 저장소 루트
 * (`rev-parse --show-toplevel`) 기준인데 트리의 `DevEntry.rel` 은 `settings.cowork.home`
 * 기준이고, home 은 저장소의 하위 폴더일 수 있다(그때 두 기준이 어긋난다). 양쪽을
 * 절대 경로로 맞추면 어긋날 여지가 없고, 저장소 밖의 파일은 그냥 조회에 걸리지 않는다 —
 * 예외 처리가 따로 필요 없다.
 *
 * 비용은 `변경된 파일 수 × 경로 깊이`이고 새로고침당 한 번 돈다.
 *
 * 알아 둘 두 가지:
 * - **무시된 파일은 아예 오지 않는다.** `git_status` 에 `--ignored` 가 없으므로
 *   `target/`·`node_modules/` 는 색 없이 남는다. 이건 매핑 버그가 아니라 없는 데이터이고,
 *   `--ignored` 를 붙이는 것은 답이 아니다 — 따뜻한 상태에서도 600~700ms(일반 status 는
 *   24ms)라 새로고침마다 낼 비용이 아니다. 필요해지면 눌렀을 때만 도는 별도 명령으로 둔다.
 * - **삭제된 파일과 이름이 바뀐 원래 경로는 디스크에 없다** → 트리에 줄이 없으니 색이 보일
 *   자리도 없다. 그래도 조상 폴더는 남아 있으므로 굴려 올리는 값은 의미가 있다(폴더가
 *   파랗게 되어 "이 안에서 뭔가 사라졌다"를 말해 준다). `orig` 를 따로 표에 넣지 않는
 *   이유도 같다 — 없는 줄에 색을 준비해 둘 필요가 없다.
 */
export function buildGitMarks(status: GitStatus | null): Map<string, GitMark> {
  const marks = new Map<string, GitMark>()
  if (!status) return marks

  const files = [...status.changes, ...status.untracked]
  if (files.length > MAX_ENTRIES) return marks

  // 루트가 `/` 로 끝나는 경우는 없지만(`--show-toplevel` 의 출력), 이어 붙이는 쪽이
  // 두 군데라 한 번 다듬어 둔다 — `//` 가 섞이면 조상 순회의 길이 비교가 무너진다.
  const root = status.root.replace(/\/+$/, "")

  for (const c of files) {
    const mark = markOfFile(c)
    const abs = `${root}/${c.path}`
    // 파일 자신은 접지 않은 색을 그대로 쓴다(삭제는 취소선까지 달라야 한다).
    marks.set(abs, mark)

    // 조상 폴더 — 경로를 `/` 에서 잘라 올라가며 루트 **바로 아래**까지만 칠한다.
    // (루트 줄은 트리에 그려지지 않으므로 칠해도 볼 자리가 없다.)
    const rolled = folderMark(mark)
    let cut = abs.lastIndexOf("/")
    while (cut > root.length) {
      const dir = abs.slice(0, cut)
      const prev = marks.get(dir)
      // 같은 등급이면 먼저 넣은 쪽을 남긴다 — 어차피 색이 같고, 덮어쓰기를 줄인다.
      if (prev !== undefined && RANK[prev] >= RANK[rolled]) break
      marks.set(dir, rolled)
      cut = dir.lastIndexOf("/")
    }
  }

  return marks
}

/**
 * 색 클래스. `--ui-*` 토큰만 쓴다(하드코딩된 팔레트 클래스 금지).
 *
 * **변경 목록(`markColor()`)과 두 군데 일부러 다르다. 저쪽을 이쪽에 맞추지 말 것** —
 * 한쪽은 "변경된 것만 모아 놓은 목록"이고 이쪽은 "전체 파일 사이에서 변경된 것을 찾는
 * 트리"라, 강조해야 할 것이 다르다:
 * - `untracked`: 회색 → **`text-ui-error`**. 트리에서 회색은 "할 말 없음"(기본 파일색)이라
 *   버전 관리 밖의 파일이 회색이면 아무 신호가 아니게 된다. IntelliJ 의 unversioned 도
 *   짙은 빨강이다.
 * - `deleted`: 빨강 → **흐린 회색 + 취소선**. 빨강을 unversioned 에 썼으니 겹칠 수 없고,
 *   IntelliJ 도 삭제된 항목에는 취소선을 긋는다(색보다 취소선이 더 분명한 신호다).
 */
export function gitMarkClass(mark: GitMark | undefined): string | undefined {
  switch (mark) {
    case "added":
      return "text-ui-success"
    case "modified":
      return "text-ui-info"
    case "untracked":
      return "text-ui-error"
    case "conflict":
      // 충돌은 색만으로는 약하다 — 손대야 하는 파일이므로 굵기까지 준다.
      return "text-ui-warning font-bold"
    case "deleted":
      return "text-muted-foreground line-through"
    default:
      return undefined
  }
}
