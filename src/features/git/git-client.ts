import { trackedInvoke } from "@/lib/tauri"

/** 변경된 파일 하나(Rust `GitChange` 와 대응). */
export interface GitChange {
  /** 저장소 루트 기준 상대 경로(이름이 바뀐 파일이면 새 경로). */
  path: string
  /** 이름이 바뀐 파일의 원래 경로. */
  orig: string | null
  /** porcelain X(인덱스 상태) 한 글자. */
  index: string
  /** porcelain Y(작업 트리 상태) 한 글자. */
  worktree: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflict: boolean
}

/** 보관해 둔 변경 한 건(Rust `GitStash` 와 대응). */
export interface GitStash {
  index: number
  name: string
  message: string
  date: string
}

/** 저장소 스냅샷(Rust `GitStatus` 와 대응). */
export interface GitStatus {
  root: string
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  detached: boolean
  noCommits: boolean
  changes: GitChange[]
  untracked: GitChange[]
  stashes: GitStash[]
}

export function gitStatus(home: string) {
  return trackedInvoke<GitStatus>("git_status", { home })
}

export function gitDiff(home: string, change: GitChange, staged: boolean) {
  return trackedInvoke<string>("git_diff", {
    home,
    path: change.path,
    orig: change.orig,
    staged,
    untracked: change.untracked,
  })
}

export function gitStage(home: string, paths: string[]) {
  return trackedInvoke<void>("git_stage", { home, paths })
}

export function gitUnstage(home: string, paths: string[]) {
  return trackedInvoke<void>("git_unstage", { home, paths })
}

export function gitRollback(home: string, paths: string[]) {
  return trackedInvoke<void>("git_rollback", { home, paths })
}

export function gitCommit(
  home: string,
  message: string,
  paths: string[],
  amend = false
) {
  return trackedInvoke<string>("git_commit", { home, message, paths, amend })
}

export function gitPush(home: string, force = false) {
  return trackedInvoke<string>("git_push", { home, force })
}

export function gitFetch(home: string) {
  return trackedInvoke<string>("git_fetch", { home })
}

export function gitPull(home: string) {
  return trackedInvoke<string>("git_pull", { home })
}

export function gitStashPush(
  home: string,
  message: string,
  includeUntracked: boolean,
  paths: string[]
) {
  return trackedInvoke<string>("git_stash_push", {
    home,
    message,
    includeUntracked,
    paths,
  })
}

export function gitStashApply(home: string, index: number, pop: boolean) {
  return trackedInvoke<string>("git_stash_apply", { home, index, pop })
}

export function gitStashDrop(home: string, index: number) {
  return trackedInvoke<string>("git_stash_drop", { home, index })
}

/** 파일 이력 한 줄(Rust `GitCommit` 과 대응). */
export interface GitCommit {
  hash: string
  short: string
  subject: string
  author: string
  /** "2 hours ago" 같은 상대 시각. */
  relative: string
  /** `2026-08-07 14:03` 형태의 절대 시각. */
  date: string
}

/**
 * 파일(또는 디렉터리) 하나의 커밋 이력 — IntelliJ 의 Git → Show History.
 *
 * `path` 는 **절대 경로**다. git 이 저장소 안의 절대 경로를 pathspec 으로 그대로 받으므로
 * 저장소 루트 상대로 바꾸지 않는다 — 홈이 저장소의 하위 폴더일 수 있어서 그 변환은
 * 프론트에서 틀리기 쉽다(`git-marks.ts` 가 색 표의 키를 절대 경로로 두는 것과 같은 이유).
 */
export function gitFileHistory(home: string, path: string, limit = 100) {
  return trackedInvoke<GitCommit[]>("git_file_history", { home, path, limit })
}

/** 커밋 하나에서 그 파일이 어떻게 바뀌었는지(unified diff). */
export function gitCommitFileDiff(home: string, hash: string, path: string) {
  return trackedInvoke<string>("git_commit_file_diff", { home, hash, path })
}

/**
 * 파일의 대표 상태 한 글자와 그 뜻.
 *
 * porcelain 은 인덱스(X)와 작업 트리(Y) 두 글자를 주는데, 목록에는 하나만 보여 준다 —
 * 충돌이 가장 급하고, 그다음이 인덱스에 올라간 상태, 없으면 작업 트리 상태다.
 */
export function changeMark(c: GitChange): { mark: string; label: string } {
  if (c.conflict) return { mark: "!", label: "충돌" }
  if (c.untracked) return { mark: "?", label: "버전 관리 안 됨" }
  const code = c.index !== " " ? c.index : c.worktree
  const label =
    {
      M: "수정됨",
      A: "추가됨",
      D: "삭제됨",
      R: "이름 변경",
      C: "복사됨",
      T: "형식 변경",
    }[code] ?? "변경됨"
  return { mark: code, label }
}

/** 상태 글자에 붙일 색(추가=초록, 삭제=빨강, 충돌=주황, 나머지=파랑/회색). */
export function markColor(mark: string): string {
  switch (mark) {
    case "A":
      return "text-ui-success"
    case "D":
      return "text-ui-error"
    case "!":
      return "text-ui-warning"
    case "?":
      return "text-muted-foreground"
    default:
      return "text-ui-info"
  }
}

/** 경로를 파일명과 그 앞의 폴더로 쪼갠다(목록에서 이름은 진하게, 폴더는 흐리게). */
export function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf("/")
  return i < 0
    ? { name: path, dir: "" }
    : { name: path.slice(i + 1), dir: path.slice(0, i) }
}
