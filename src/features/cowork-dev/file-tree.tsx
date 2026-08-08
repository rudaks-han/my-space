import {
  BracesIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DatabaseIcon,
  FileCodeIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  GlobeIcon,
  Loader2Icon,
  type LucideIcon,
} from "lucide-react"
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { GitHistoryDialog } from "@/features/cowork-dev/git-history-dialog"
import { gitMarkClass, type GitMark } from "@/features/cowork-dev/git-marks"
import { gitStage } from "@/features/git/git-client"
import type { DevEntry } from "@/features/cowork-dev/types"
import type { ProjectTree } from "@/features/cowork-dev/use-project-tree"
import {
  dirOf,
  type DirTarget,
  type FileOps,
} from "@/features/cowork-dev/use-file-ops"
import { cn } from "@/lib/utils"

/** 한 줄의 들여쓰기 — 셰브론 슬롯(14px)과 맞춘 값이라 깊이가 눈으로 세어진다. */
const INDENT = 14
const PAD_LEFT = 8

/**
 * 확장자 → 아이콘. **색은 두 종류만 준다**: `.http` 는 이 화면에서 바로 실행되는 파일이고
 * `.java` 는 cowork 의 본체라, 수백 줄짜리 트리에서 그 둘만 먼저 눈에 띄어야 한다.
 * 나머지를 색으로 구분하면 전부 튀어서 아무것도 튀지 않는다.
 *
 * 클래스 이름은 조립하지 않고 통째로 적는다 — Tailwind v4 는 소스를 글자로 훑으므로
 * `text-${x}` 로 만들면 규칙이 생성되지 않고, 에러 없이 색만 사라진다.
 */
function fileIcon(name: string): { Icon: LucideIcon; color: string } {
  const ext = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
    : ""
  switch (ext) {
    case "http":
    case "rest":
      return { Icon: GlobeIcon, color: "text-ui-info" }
    case "java":
      return { Icon: FileCodeIcon, color: "text-ui-warning" }
    case "kt":
      return { Icon: FileCodeIcon, color: "text-muted-foreground" }
    case "sql":
      return { Icon: DatabaseIcon, color: "text-muted-foreground" }
    case "md":
      return { Icon: FileTextIcon, color: "text-muted-foreground" }
    case "json":
    case "yml":
    case "yaml":
    case "xml":
    case "properties":
      return { Icon: BracesIcon, color: "text-muted-foreground" }
    default:
      return { Icon: FileIcon, color: "text-muted-foreground" }
  }
}

/* ───────────────────────── 우클릭 메뉴 ─────────────────────────
 *
 * IntelliJ 의 Project 툴윈도 우클릭과 같은 묶음이다. 대상은 **우클릭한 한 줄**이고
 * (트리에 다중 선택이 없다), 빈 자리를 우클릭하면 프로젝트 루트가 대상이 된다.
 *
 * 실제 조작은 `useFileOps` 가 한다 — 여기 있는 것은 메뉴와 입력·확인 대화창뿐이다.
 * 대화창을 직접 만드는 이유는 이 앱이 웹뷰의 `confirm()`/`prompt()` 를 쓰지 않기
 * 때문이다(네이티브 모달이라 화면과 따로 논다 — 뷰의 `DirtyCloseDialog` 와 같은 판단).
 */

/** 메뉴가 화면 가장자리에서 잘리지 않도록 남겨 두는 여백(px). */
const MENU_EDGE = 8

/** 우클릭 메뉴의 위치와 대상(`entry` 가 없으면 트리의 빈 자리 = 루트). */
interface MenuState {
  x: number
  y: number
  entry: DevEntry | null
}

/** 이름을 묻는 대화창의 용도 — 문구와 확정 동작이 갈린다. */
type PromptKind =
  | { kind: "newFile"; dir: DirTarget }
  | { kind: "newDir"; dir: DirTarget }
  | { kind: "rename"; entry: DevEntry }

function MenuItem({
  label,
  hint,
  danger,
  disabled,
  onClick,
}: {
  label: string
  /** 오른쪽에 흐리게 붙는 보조 문구(대상 이름 등). */
  hint?: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        "flex h-8 w-full items-center gap-3 px-3 text-left text-[13px] hover:bg-ui-list-hover disabled:pointer-events-none disabled:opacity-40",
        danger && "text-ui-error"
      )}
      onClick={onClick}
    >
      <span className="flex-1 truncate">{label}</span>
      {hint && (
        <span className="max-w-32 shrink-0 truncate text-[11px] text-muted-foreground">
          {hint}
        </span>
      )}
    </button>
  )
}

function MenuSep() {
  return <div className="my-1 h-px bg-border" />
}

function TreeContextMenu({
  state,
  root,
  ops,
  gitHome,
  onClose,
  onPrompt,
  onDelete,
  onGitAdd,
  onHistory,
}: {
  state: MenuState
  root: string
  ops: FileOps
  /** git 저장소일 때만 채워진다(= Git 묶음을 달지 여부). */
  gitHome: string | null
  onClose: () => void
  onPrompt: (p: PromptKind) => void
  onDelete: (entry: DevEntry) => void
  onGitAdd: (entry: DevEntry) => void
  onHistory: (entry: DevEntry) => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ x: state.x, y: state.y })

  // 실제 크기를 재서 화면 안으로 밀어 넣는다(`FloatingMenu` 와 같다). 이 메뉴는 열 줄
  // 남짓이라 트리 아래쪽에서 우클릭하면 삭제·경로 복사가 창 밖으로 나가 누를 수 없다.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setPos({
      x: Math.min(state.x, window.innerWidth - el.offsetWidth - MENU_EDGE),
      y: Math.min(state.y, window.innerHeight - el.offsetHeight - MENU_EDGE),
    })
  }, [state.x, state.y])

  useEffect(() => {
    /*
     * 바깥 클릭·스크롤·Esc 면 닫는다. 요점은 **메뉴 안에서 시작한 mousedown 을 여기서
     * 걸러내는 것**이고, 그 판단은 `ref.contains` 여야 한다 — 메뉴 div 의 React
     * `onMouseDown` 에서 `stopPropagation()` 하는 것으로는 막을 수 없다. capture 는
     * `document` 에서 시작하는데 React 의 합성 핸들러는 루트 컨테이너의 bubble 단계에
     * 붙으므로 이 리스너가 **항상 먼저** 돈다. 그대로 두면 항목을 누르는 순간 메뉴가
     * 언마운트되고, 눌린 버튼이 DOM 에서 사라져 `click` 이 아예 발생하지 않는다 —
     * 메뉴는 뜨는데 어느 항목도 실행되지 않는 상태가 된다.
     */
    const close = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", close, true)
    document.addEventListener("scroll", close, true)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", close, true)
      document.removeEventListener("scroll", close, true)
      document.removeEventListener("keydown", onKey)
    }
  }, [onClose])

  const entry = state.entry
  // 새로 만들기·붙여넣기의 기준 폴더: 폴더를 우클릭했으면 그 안, 파일이면 그 옆,
  // 빈 자리면 루트. IntelliJ 와 같은 규칙이다.
  const dir: DirTarget = entry ? dirOf(entry, root) : { path: root, rel: "" }
  const clip = ops.clipboard

  const act = (fn: () => void) => () => {
    onClose()
    fn()
  }

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-56 overflow-hidden rounded-[10px] border border-border bg-popover py-1 text-popover-foreground shadow-[0_4px_16px_rgba(0,0,0,0.16)]"
      style={{ left: pos.x, top: pos.y }}
      // 메뉴 위에서의 우클릭은 아무 뜻도 없다. 막지 않으면 트리 뿌리의 `onContextMenu` 까지
      // 올라가 대상이 루트인 메뉴가 그 자리에 다시 열린다.
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div className="truncate px-3 py-1 text-[11px] font-bold text-muted-foreground">
        {entry ? entry.name : root.slice(root.lastIndexOf("/") + 1) || root}
      </div>
      {/* 조작이 도는 중에는 파일을 바꾸는 항목을 전부 잠근다 — 메뉴는 누르면 닫히지만
          다시 열어 두 번째를 시작할 수 있고, 그러면 두 번째가 첫 번째가 만들 파일을
          모르는 상태로 판단한다(복사가 겹쳐 돌면 `사본 2` 까지 생긴다). */}
      <MenuItem
        label="새 파일…"
        hint={dir.rel || "루트"}
        disabled={ops.busy}
        onClick={act(() => onPrompt({ kind: "newFile", dir }))}
      />
      <MenuItem
        label="새 디렉터리…"
        hint={dir.rel || "루트"}
        disabled={ops.busy}
        onClick={act(() => onPrompt({ kind: "newDir", dir }))}
      />
      <MenuSep />
      {entry && (
        <>
          <MenuItem label="잘라내기" onClick={act(() => ops.cut(entry))} />
          <MenuItem label="복사" onClick={act(() => ops.copy(entry))} />
        </>
      )}
      <MenuItem
        label="붙여넣기"
        hint={
          clip
            ? `${clip.cut ? "이동" : "복사"} · ${clip.entry.name}`
            : undefined
        }
        // 클립보드가 비어 있으면 누를 것이 없다 — 항목을 숨기지 않고 흐리게 두는 것은
        // "붙여넣기가 없는 화면" 으로 읽히지 않게 하려는 것이다.
        disabled={!clip || ops.busy}
        onClick={act(() => void ops.paste(dir))}
      />
      {entry && (
        <>
          <MenuSep />
          <MenuItem
            label="이름 바꾸기…"
            disabled={ops.busy}
            onClick={act(() => onPrompt({ kind: "rename", entry }))}
          />
          <MenuItem
            label="삭제…"
            danger
            disabled={ops.busy}
            onClick={act(() => onDelete(entry))}
          />
        </>
      )}
      {/*
       * Git — IntelliJ 의 `Git ▸ Add` / `Git ▸ Show History` 두 개다.
       *
       * **하위 메뉴가 아니라 이름표가 붙은 묶음으로 그린다.** 항목이 둘뿐이라 하위 메뉴는
       * 손이 한 번 더 들고(펼치는 동작), 이 파일의 다른 메뉴에는 하위 메뉴가 없어서
       * 화면 가장자리 보정(`MENU_EDGE`)을 하나 더 만들어야 한다.
       *
       * 대상은 **우클릭한 줄**뿐이라 빈 자리(=루트)에서는 달지 않는다. 루트에 `git add` 를
       * 걸면 한 번의 클릭이 프로젝트 전체를 스테이지에 올려 버리는데, 그건 트리 우클릭이
       * 할 일이 아니다(그 조작은 개발 → Git 화면에 있다).
       */}
      {gitHome && entry && (
        <>
          <MenuSep />
          <div className="px-3 py-1 text-[11px] font-bold text-muted-foreground">
            Git
          </div>
          <MenuItem
            label="추가"
            hint="git add"
            onClick={act(() => onGitAdd(entry))}
          />
          <MenuItem label="이력 보기…" onClick={act(() => onHistory(entry))} />
        </>
      )}
      <MenuSep />
      <MenuItem
        label="경로 복사"
        onClick={act(() => {
          const p = entry?.path ?? root
          void navigator.clipboard
            .writeText(p)
            .then(() =>
              toast.success("경로를 복사했습니다", { description: p })
            )
            .catch((e) => toast.error("복사 실패", { description: String(e) }))
        })}
      />
      <MenuItem
        label="Finder 에서 열기"
        onClick={act(() => {
          void (async () => {
            const { revealItemInDir } =
              await import("@tauri-apps/plugin-opener")
            await revealItemInDir(entry?.path ?? root)
          })()
        })}
      />
    </div>
  )
}

/**
 * 이름 입력 대화창 — 새 파일 · 새 디렉터리 · 이름 바꾸기가 함께 쓴다.
 *
 * 이름 바꾸기일 때 **확장자를 뺀 부분만 선택**해 둔다(IntelliJ 와 같다): 대개 바꾸려는
 * 것은 `Foo` 이고 `.java` 는 그대로다. 전체를 선택해 두면 타자를 치는 순간 확장자가
 * 사라져 파일 종류가 바뀐다.
 */
function NamePrompt({
  prompt,
  onCancel,
  onSubmit,
}: {
  prompt: PromptKind
  onCancel: () => void
  onSubmit: (name: string) => void
}) {
  const initial = prompt.kind === "rename" ? prompt.entry.name : ""
  const [name, setName] = useState(initial)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    if (prompt.kind !== "rename") return
    const dot = initial.lastIndexOf(".")
    el.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [prompt.kind, initial])

  const title =
    prompt.kind === "newFile"
      ? "새 파일"
      : prompt.kind === "newDir"
        ? "새 디렉터리"
        : "이름 바꾸기"
  const where =
    prompt.kind === "rename"
      ? prompt.entry.rel
      : prompt.dir.rel || "프로젝트 루트"

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onCancel}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          const v = name.trim()
          if (v !== "") onSubmit(v)
        }}
        // 트리 뿌리의 `select-none` 이 여기까지 상속된다 — 이름 입력칸의 글자를 마우스로
        // 고를 수 없으면 이름 바꾸기가 타자로만 가능해진다. 대화창 안은 되돌려 놓는다.
        className="flex w-full max-w-sm flex-col gap-3 rounded-[10px] border border-border bg-card p-4 shadow-[0_4px_16px_rgba(0,0,0,0.16)] select-text"
      >
        <div className="text-[18px] font-bold tracking-[-0.01em]">{title}</div>
        <p className="truncate text-[13px] text-muted-foreground" title={where}>
          {where}
        </p>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={
            prompt.kind === "newFile"
              ? "예: service/UserService.java"
              : prompt.kind === "newDir"
                ? "예: service"
                : ""
          }
          className="h-9 rounded-lg border border-border bg-background px-3 font-mono text-[13px] outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid"
        />
        {prompt.kind !== "rename" && (
          // 여러 겹 이름이 되는 것은 Rust 가 중간 폴더를 만들어 주기 때문이라,
          // 그 사실을 여기서 말해 둔다(IntelliJ 도 같은 입력을 받는다).
          <p className="text-[11px] text-muted-foreground">
            <span className="font-mono">/</span> 를 넣으면 중간 폴더까지 함께
            만듭니다.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
            취소
          </Button>
          <Button size="sm" type="submit" disabled={name.trim() === ""}>
            확인
          </Button>
        </div>
      </form>
    </div>
  )
}

/**
 * 삭제 확인.
 *
 * 폴더는 안에 든 것까지 함께 사라지므로 그 사실을 문구로 못박는다. 어디로 가는지도
 * 말한다 — 휴지통으로 옮기지 못하는 환경에서는 영구 삭제가 되고, 그 결과는 조작이
 * 끝난 뒤 토스트가 다시 알린다.
 */
function DeleteConfirm({
  entry,
  onCancel,
  onConfirm,
}: {
  entry: DevEntry
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        // 같은 이유로 여기도 되돌린다 — 지울 경로를 복사해 확인하고 싶을 수 있다.
        className="flex w-full max-w-sm flex-col gap-3 rounded-[10px] border border-border bg-card p-4 shadow-[0_4px_16px_rgba(0,0,0,0.16)] select-text"
      >
        <div className="text-[18px] font-bold tracking-[-0.01em]">
          {entry.dir ? "디렉터리를 삭제할까요?" : "파일을 삭제할까요?"}
        </div>
        <p className="text-[13px] text-muted-foreground">
          <span className="font-bold text-foreground">{entry.rel}</span>
          {entry.dir ? " 안의 모든 파일이 함께 삭제됩니다. " : " 을(를) "}
          휴지통으로 옮깁니다.
        </p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            취소
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-ui-error hover:text-ui-error"
            onClick={onConfirm}
          >
            삭제
          </Button>
        </div>
      </div>
    </div>
  )
}

interface RowProps {
  entry: DevEntry
  depth: number
  open: boolean
  loading: boolean
  /** 가운데 편집기에 떠 있는 파일. 폴더는 열릴 것이 없으므로 언제나 false 다. */
  active: boolean
  /**
   * 트리에서 고른 줄(파일이든 폴더든) — 우클릭도 이 선택을 옮긴다.
   * **와인색 알약을 갖는 것은 이 값**이라, 폴더도 파일과 똑같이 선택 표시가 붙는다.
   */
  selected: boolean
  /** 우클릭 메뉴가 이 줄을 대상으로 열려 있다. */
  targeted: boolean
  /** 잘라내기로 집어 둔 항목 — 파인더처럼 흐리게 그려 어디를 옮기는지 보이게 한다. */
  cut: boolean
  /** 이 줄의 git 상태(없으면 변경 없음 또는 아직 상태를 못 읽은 것). */
  mark?: GitMark
  onClick: () => void
  /** 폴더에만 붙는다 — 펼침/접힘은 더블클릭이다. */
  onDoubleClick?: () => void
  /** 셰브론만 누른 경우(폴더의 한 번 클릭 펼침). 없으면 셰브론도 줄과 같이 동작한다. */
  onToggle?: () => void
  onMenu: (e: React.MouseEvent) => void
}

function TreeRow({
  entry,
  depth,
  open,
  loading,
  active,
  selected,
  targeted,
  cut,
  mark,
  onClick,
  onDoubleClick,
  onToggle,
  onMenu,
}: RowProps) {
  const folder = entry.dir
  const { Icon, color } = folder
    ? {
        Icon: open ? FolderOpenIcon : FolderIcon,
        color: "text-muted-foreground",
      }
    : fileIcon(entry.name)

  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onMenu}
      title={entry.rel}
      // 가로 스크롤이 있어도 hover 배경이 줄 끝까지 이어지도록 `min-w-max` 를 함께 준다.
      className={cn(
        "flex h-[22px] w-full min-w-max cursor-pointer items-center gap-1 pr-2 text-left text-[13px] whitespace-nowrap transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid",
        /*
         * **와인색 알약은 "고른 줄" 하나의 뜻이다** — 파일이든 폴더든 같다. 알약을
         * "편집기에 떠 있는 파일" 에 묶어 두면 폴더는 클릭해도 아무 표시가 없어(폴더는
         * 열릴 것이 없으므로 `active` 가 될 수 없다) 무엇을 골랐는지 보이지 않는다.
         *
         * 알약이 선택으로 옮겨 갔으니 열려 있는 파일은 옅은 배경으로 내려온다. 두 줄이
         * 동시에 와인색이 되지 않으므로 "지금 고른 줄" 은 언제나 하나이고, 편집기에 뜬
         * 파일도 여전히 배경으로 구분된다(파일을 클릭하면 둘이 같은 줄이라 하나로 보인다).
         * 아직 아무것도 고르지 않았으면 열린 파일이 선택 자리를 대신한다 — `FileTree` 가
         * `selectedPath ?? activePath` 로 넘긴다.
         */
        selected
          ? "bg-ui-selection font-semibold text-ui-selection-fg"
          : "hover:bg-ui-list-hover",
        (active || targeted) && !selected && "bg-ui-list-hover font-semibold",
        cut && "opacity-50"
      )}
      style={{ paddingLeft: PAD_LEFT + depth * INDENT }}
    >
      {/*
       * 셰브론 슬롯 — 파일도 빈 슬롯을 차지해야 이름이 세로로 줄을 맞춘다.
       *
       * 폴더의 셰브론은 **한 번 클릭으로 펼친다**(IntelliJ 와 같다). 줄 전체는 선택이고
       * 펼침은 더블클릭이지만, 화살표를 눌렀을 때만은 그것이 곧 "펼쳐라" 라는 뜻이다.
       * `stopPropagation` 이 줄의 `onClick`(선택)까지 가는 것을 막는다 — 버튼 안에 버튼을
       * 넣을 수 없으므로 `span` 에 핸들러를 걸었다. `onDoubleClick` 도 같이 막는 이유는
       * 화살표를 두 번 빨리 누르면 클릭 두 번 **더하기** 줄의 더블클릭까지 세 번이 되어
       * 결과가 뒤집히기 때문이다.
       */}
      <span
        className="flex size-3.5 shrink-0 items-center justify-center"
        onClick={
          onToggle
            ? (e) => {
                e.stopPropagation()
                onToggle()
              }
            : undefined
        }
        onDoubleClick={onToggle ? (e) => e.stopPropagation() : undefined}
      >
        {loading ? (
          <Loader2Icon className="size-3 animate-spin" />
        ) : folder ? (
          open ? (
            <ChevronDownIcon className="size-3" />
          ) : (
            <ChevronRightIcon className="size-3" />
          )
        ) : null}
      </span>
      <span className="flex size-4 shrink-0 items-center justify-center">
        <Icon className={cn("size-3.5", selected ? "opacity-90" : color)} />
      </span>
      {/*
       * git 색은 **이름에만**, 그리고 **선택되지 않은 줄에만** 얹는다. 선택된 줄은 와인색
       * `bg-ui-selection` 알약에 흰 글자(`text-ui-selection-fg`)라, 그 위에 초록·파랑을
       * 덮으면 대비가 무너져 이름 자체를 못 읽는다 — 그 줄이 무엇인지는 이미 알고 있으므로
       * 색을 잃어도 손해가 없다. 아이콘 색은 파일 종류, 이름 색은 VCS 라는 분리를 지킨다.
       */}
      <span className={cn(selected ? undefined : gitMarkClass(mark))}>
        {entry.name}
      </span>
    </button>
  )
}

interface RowsProps {
  rel: string
  depth: number
  tree: ProjectTree
  activePath: string | null
  marks?: Map<string, GitMark>
  /** 트리에서 고른 줄의 절대 경로. */
  selectedPath: string | null
  /** 메뉴가 열려 있는 대상의 절대 경로. */
  menuPath: string | null
  /** 잘라내기로 집어 둔 항목의 절대 경로. */
  cutPath: string | null
  onSelect: (entry: DevEntry) => void
  onOpen: (entry: DevEntry) => void
  onMenu: (e: React.MouseEvent, entry: DevEntry) => void
}

/** 한 폴더의 자식들 + 펼쳐진 폴더의 자식들(재귀). 캐시에 없으면 아무것도 그리지 않는다. */
function TreeRows({
  rel,
  depth,
  tree,
  activePath,
  marks,
  selectedPath,
  menuPath,
  cutPath,
  onSelect,
  onOpen,
  onMenu,
}: RowsProps) {
  const list = tree.children[rel]
  if (!list) return null
  return (
    <>
      {list.map((entry) => {
        const open = entry.dir && tree.expanded.has(entry.rel)
        return (
          <Fragment key={entry.path}>
            <TreeRow
              entry={entry}
              depth={depth}
              open={open}
              loading={tree.loading.has(entry.rel)}
              active={!entry.dir && entry.path === activePath}
              selected={entry.path === selectedPath}
              targeted={entry.path === menuPath}
              cut={entry.path === cutPath}
              // 표의 키는 **절대 경로**다 — `rel` 은 저장소 루트가 아니라 프로젝트
              // 루트(설정 → Cowork) 기준이라, 그것으로 찾으면 아무것도 맞지 않거나
              // 엉뚱한 파일의 색이 붙는다(`git-marks.ts` 참고).
              mark={marks?.get(entry.path)}
              /*
               * **폴더는 한 번 클릭으로 펼치지 않는다.** 고르는 것과 펼치는 것을 한
               * 동작에 묶으면 우클릭 메뉴의 대상을 지정하려고 누르는 것만으로 큰 폴더가
               * 열리면서 목록이 밀린다(그 폴더를 읽는 IPC 도 함께 나간다). IntelliJ 처럼
               * 클릭 = 선택, 더블클릭 = 펼침/접힘이고 셰브론만은 한 번 클릭이다.
               *
               * 파일은 예전과 같다 — 한 번 클릭으로 연다. 이 트리에서 파일을 누르는
               * 이유는 편집기에 띄우는 것 하나뿐이라, 그걸 두 번 클릭으로 만들면 가장
               * 잦은 동작에 손이 한 번 더 든다.
               */
              onClick={() => {
                onSelect(entry)
                if (!entry.dir) onOpen(entry)
              }}
              onDoubleClick={
                entry.dir ? () => tree.toggle(entry.rel) : undefined
              }
              onToggle={entry.dir ? () => tree.toggle(entry.rel) : undefined}
              onMenu={(e) => onMenu(e, entry)}
            />
            {open && (
              <TreeRows
                rel={entry.rel}
                depth={depth + 1}
                tree={tree}
                activePath={activePath}
                marks={marks}
                selectedPath={selectedPath}
                menuPath={menuPath}
                cutPath={cutPath}
                onSelect={onSelect}
                onOpen={onOpen}
                onMenu={onMenu}
              />
            )}
          </Fragment>
        )
      })}
    </>
  )
}

export interface FileTreeProps {
  /** 프로젝트 루트(절대 경로). 비어 있으면 아직 저장소를 정하지 않은 것이다. */
  root: string
  tree: ProjectTree
  /** 가운데에서 보고 있는 파일의 **절대 경로**. */
  activePath?: string | null
  /**
   * `절대 경로` → git 상태 표(`buildGitMarks`). 컨텍스트가 아니라 prop 인 이유는 이 파일이
   * 이미 전부 prop 으로 움직이기 때문이고, 없어도 트리는 색 없이 그대로 동작한다.
   *
   * 새로고침마다 `Map` 이 새로 오므로 모든 줄이 리렌더되는데, 갱신 계기가 툴바 버튼
   * (수동)뿐이라 감당할 수 있는 비용이다 — 폴링을 붙이는 순간 이 판단이 깨진다.
   */
  marks?: Map<string, GitMark>
  /**
   * 파일 줄을 눌렀을 때만 불린다(한 번 클릭). 폴더 줄은 클릭이 선택이고 펼침/접힘은
   * 더블클릭이라 여기로 오지 않는다 — 그쪽은 `tree.toggle` 이 직접 처리한다.
   */
  onOpen: (entry: DevEntry) => void
  /**
   * 우클릭 메뉴의 동작(새로 만들기·이름 바꾸기·삭제·잘라내기/복사/붙여넣기).
   *
   * 없으면 메뉴 자체를 달지 않는다 — 이 트리를 읽기 전용으로 쓰는 화면이 생겼을 때
   * 조작만 빼고 그대로 쓸 수 있어야 한다.
   */
  ops?: FileOps
  /**
   * git 저장소일 때의 홈 경로(= `git_status` 가 성공한 값). 없으면 우클릭 메뉴에 Git 묶음을
   * 달지 않는다 — 저장소가 아닌 폴더에서 `추가`·`이력 보기` 는 누를 때마다 오류만 낸다.
   *
   * `root` 를 그대로 쓰지 않는 이유가 그것이다: 트리는 저장소가 아닌 폴더도 그린다.
   */
  gitHome?: string | null
  /** `git add` 가 성공한 뒤 — 트리의 git 색(`marks`)을 다시 읽게 하는 통로. */
  onGitChanged?: () => void
  className?: string
}

/**
 * 왼쪽 프로젝트 트리.
 *
 * 루트 폴더 자신은 그리지 않는다 — 저장소 이름은 툴바의 프로젝트 칩에 이미 있고,
 * 트리에 한 번 더 두면 모든 줄이 한 칸씩 밀려 폭만 먹는다.
 */
export function FileTree({
  root,
  tree,
  activePath = null,
  marks,
  onOpen,
  ops,
  gitHome = null,
  onGitChanged,
  className,
}: FileTreeProps) {
  const rootList = tree.children[""]
  const rootLoading = tree.loading.has("")

  const [menu, setMenu] = useState<MenuState | null>(null)
  const [prompt, setPrompt] = useState<PromptKind | null>(null)
  const [pendingDelete, setPendingDelete] = useState<DevEntry | null>(null)
  /** 이력 대화창의 대상. 열려 있는 동안만 값이 있다. */
  const [history, setHistory] = useState<DevEntry | null>(null)
  /**
   * 트리에서 고른 줄. 열려 있는 파일(`activePath`)과 **다른 값**이다: 폴더도 고를 수 있고,
   * 우클릭 메뉴의 대상이 어디인지 눈으로 확인하는 수단이라 파일을 열지 않아도 남아야 한다.
   */
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  const openMenu = (e: React.MouseEvent, entry: DevEntry | null) => {
    if (!ops) return
    e.preventDefault()
    // 줄에서 열었을 때 아래의 "빈 자리" 핸들러까지 가면 대상이 루트로 덮인다.
    e.stopPropagation()
    // 우클릭도 선택을 옮긴다(파인더·IntelliJ 와 같다) — 메뉴를 닫은 뒤에도 방금 무엇을
    // 대상으로 삼았는지 줄에 남아 있어야 한다.
    setSelectedPath(entry?.path ?? null)
    setMenu({ x: e.clientX, y: e.clientY, entry })
  }

  return (
    <div
      className={cn(
        "min-h-0 overflow-auto py-1",
        // `select-none` 은 장식이 아니다: 우클릭하면 WKWebView 가 눌린 낱말을 선택해
        // 파란 블록이 남고, 더블클릭(폴더 펼침)은 이름을 통째로 선택한다 — 둘 다 트리에서는
        // 아무 뜻도 없는 표시다. 경로가 필요하면 메뉴의 **경로 복사**가 그 길이다.
        "select-none",
        className
      )}
      // 빈 자리 우클릭 = 프로젝트 루트가 대상(파인더·IntelliJ 와 같다). 트리가 비어 있어도
      // 첫 파일을 만들 길이 있어야 하므로 이 핸들러가 안내 문구 위에서도 살아 있어야 한다.
      onContextMenu={(e) => openMenu(e, null)}
    >
      {tree.error ? (
        <p className="px-2 py-1 text-[13px] text-ui-error">{tree.error}</p>
      ) : rootLoading && !rootList ? (
        <p className="px-2 py-1 text-[13px] text-muted-foreground">
          불러오는 중…
        </p>
      ) : !rootList || rootList.length === 0 ? (
        // 어느 폴더가 비었는지는 툴바 칩만으로는 헷갈린다 — 경로를 툴팁으로 붙여 둔다.
        <p className="px-2 py-1 text-[13px] text-muted-foreground" title={root}>
          비어 있는 폴더입니다.
        </p>
      ) : (
        <TreeRows
          rel=""
          depth={0}
          tree={tree}
          activePath={activePath}
          marks={marks}
          // 아직 아무 줄도 고르지 않았으면(탭을 복원하며 막 열린 화면) 편집기에 떠 있는
          // 파일이 선택 자리를 대신한다 — 그러지 않으면 파일이 열려 있는데 트리에는
          // 아무 표시도 없다.
          selectedPath={selectedPath ?? activePath}
          menuPath={menu?.entry?.path ?? null}
          cutPath={ops?.clipboard?.cut ? ops.clipboard.entry.path : null}
          onSelect={(entry) => setSelectedPath(entry.path)}
          onOpen={onOpen}
          onMenu={(e, entry) => openMenu(e, entry)}
        />
      )}

      {ops && menu && (
        <TreeContextMenu
          state={menu}
          root={root}
          ops={ops}
          gitHome={gitHome}
          onClose={() => setMenu(null)}
          onPrompt={setPrompt}
          onDelete={setPendingDelete}
          /*
           * `git add` — 추적되지 않던 파일에는 IntelliJ 의 "Add to VCS" 이고, 이미
           * 추적 중인 파일에는 변경을 스테이지에 올리는 일이다(같은 명령이라 항목을
           * 하나로 둔다). 확인 대화창을 두지 않는 이유는 되돌리기 쉬운 조작이기
           * 때문이고(개발 → Git 에서 unstage), 결과는 토스트와 트리 색이 알려 준다.
           */
          onGitAdd={(entry) => {
            if (!gitHome) return
            void gitStage(gitHome, [entry.path])
              .then(() => {
                toast.success("Git 에 추가했습니다", {
                  description: entry.rel,
                })
                onGitChanged?.()
              })
              .catch((e) =>
                toast.error("Git 추가 실패", { description: String(e) })
              )
          }}
          onHistory={setHistory}
        />
      )}
      {gitHome && history && (
        <GitHistoryDialog
          // 대상이 바뀌면 통째로 다시 마운트시킨다 — 대화창이 상태를 되돌리지 않는 것은
          // 이 `key` 를 전제로 한 설계다(그쪽 머리말 참고).
          key={history.path}
          home={gitHome}
          path={history.path}
          label={history.rel}
          onClose={() => setHistory(null)}
        />
      )}
      {ops && prompt && (
        <NamePrompt
          prompt={prompt}
          onCancel={() => setPrompt(null)}
          onSubmit={(name) => {
            setPrompt(null)
            if (prompt.kind === "rename") void ops.rename(prompt.entry, name)
            else void ops.create(prompt.dir, name, prompt.kind === "newDir")
          }}
        />
      )}
      {ops && pendingDelete && (
        <DeleteConfirm
          entry={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const target = pendingDelete
            setPendingDelete(null)
            void ops.remove(target)
          }}
        />
      )}
    </div>
  )
}
