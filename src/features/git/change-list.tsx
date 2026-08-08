import { useEffect, useRef, useState } from "react"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"

import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"
import {
  changeMark,
  markColor,
  splitPath,
  type GitChange,
  type GitStatus,
} from "./git-client"

/** 파일 하나에 걸 수 있는 동작(컨텍스트 메뉴 → 뷰). */
export type ChangeAction =
  "diff" | "stage" | "unstage" | "rollback" | "stash" | "reveal"

/** 우클릭 메뉴의 위치와 대상. */
interface MenuState {
  x: number
  y: number
  change: GitChange
}

/** 컨텍스트 메뉴 한 줄. */
function MenuItem({
  label,
  danger,
  onClick,
}: {
  label: string
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-8 w-full items-center px-3 text-left text-[13px] hover:bg-ui-list-hover",
        danger && "text-ui-error"
      )}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

/**
 * 우클릭 메뉴. 대상은 **우클릭한 파일 하나**다(체크 상태와 무관) — 체크는 "커밋에 넣을
 * 목록"이라는 뜻이라, 거기에 롤백까지 걸면 무엇이 지워질지 예측할 수 없다.
 */
function ContextMenu({
  state,
  onClose,
  onAction,
}: {
  state: MenuState
  onClose: () => void
  onAction: (action: ChangeAction, change: GitChange) => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    // 메뉴 안에서 시작한 mousedown 은 `ref.contains` 로 걸러야 한다 —
    // 이유는 `components/shell/floating-menu.tsx` 의 같은 자리에 적어 두었다.
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

  const c = state.change
  const pick = (action: ChangeAction) => () => {
    onClose()
    onAction(action, c)
  }

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-52 overflow-hidden rounded-[10px] border border-border bg-popover py-1 shadow-[0_4px_16px_rgba(0,0,0,0.16)]"
      style={{ left: state.x, top: state.y }}
    >
      <div className="truncate px-3 py-1 text-[11px] font-bold text-muted-foreground">
        {splitPath(c.path).name}
      </div>
      <MenuItem label="차이 보기" onClick={pick("diff")} />
      {c.untracked ? (
        <MenuItem label="VCS 에 추가" onClick={pick("stage")} />
      ) : c.staged ? (
        <MenuItem label="스테이지에서 내리기" onClick={pick("unstage")} />
      ) : (
        <MenuItem label="스테이지에 올리기" onClick={pick("stage")} />
      )}
      <MenuItem label="변경사항 보관(Stash)…" onClick={pick("stash")} />
      <MenuItem
        label={c.untracked ? "파일 삭제…" : "롤백…"}
        danger
        onClick={pick("rollback")}
      />
      <div className="my-1 h-px bg-border" />
      <MenuItem label="Finder 에서 보기" onClick={pick("reveal")} />
    </div>
  )
}

/** 목록 행 하나. */
function ChangeRow({
  change,
  checked,
  active,
  onCheck,
  onActivate,
  onMenu,
}: {
  change: GitChange
  checked: boolean
  active: boolean
  onCheck: (checked: boolean) => void
  onActivate: () => void
  onMenu: (e: React.MouseEvent) => void
}) {
  const { mark, label } = changeMark(change)
  const { name, dir } = splitPath(change.path)
  return (
    <div
      className={cn(
        // 왼쪽 여백 2.125rem = 섹션 헤더의 px-2(0.5) + 체크박스(1.125) + gap-2(0.5) —
        // 파일의 체크박스가 섹션 헤더의 셰브론 바로 아래에 오도록 한 단계 들여쓴다
        // (사이드바의 중첩 항목과 같은 규칙). 들여쓰기가 없으면 헤더와 파일이 한 줄기로 보인다.
        "group mx-1.5 flex min-h-8 cursor-default items-center gap-2 rounded-lg pr-2 pl-[2.125rem] whitespace-nowrap",
        active
          ? "bg-ui-list-active text-ui-list-active-fg"
          : "hover:bg-ui-list-hover"
      )}
      onClick={onActivate}
      onContextMenu={onMenu}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onCheck(v === true)}
        onClick={(e) => e.stopPropagation()}
        aria-label={`${change.path} 커밋에 포함`}
      />
      <span
        title={label}
        className={cn(
          "w-3 shrink-0 text-center font-mono text-[13px] font-bold",
          active ? "text-current" : markColor(mark)
        )}
      >
        {mark}
      </span>
      <span className="text-[13px] font-semibold">{name}</span>
      {dir && (
        <span
          className={cn(
            "text-[11px]",
            active ? "text-current/80" : "text-muted-foreground"
          )}
          title={change.path}
        >
          {dir}
        </span>
      )}
      {change.orig && (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          ← {splitPath(change.orig).name}
        </span>
      )}
      {change.staged && change.unstaged && (
        <span className="shrink-0 rounded-full bg-ui-warning/15 px-1.5 text-[11px] font-bold text-ui-warning">
          일부 스테이지
        </span>
      )}
    </div>
  )
}

/** 접을 수 있는 섹션 헤더(전체 선택 체크박스 포함). */
function SectionHeader({
  title,
  count,
  open,
  allChecked,
  someChecked,
  onToggleOpen,
  onCheckAll,
}: {
  title: string
  count: number
  open: boolean
  allChecked: boolean
  someChecked: boolean
  onToggleOpen: () => void
  onCheckAll: (checked: boolean) => void
}) {
  return (
    <div className="mx-1.5 flex h-9 items-center gap-2 px-2">
      <Checkbox
        checked={allChecked}
        indeterminate={!allChecked && someChecked}
        disabled={count === 0}
        onCheckedChange={(v) => onCheckAll(v === true)}
        aria-label={`${title} 전체 선택`}
      />
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1 rounded-lg px-1 text-left hover:bg-ui-list-hover"
        onClick={onToggleOpen}
      >
        {open ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        {/*
         * 그룹 라벨은 파일과 세 가지로 갈라 둔다 — 색(흐린 회색 ↔ 본문색), 크기(15px ↔ 13px),
         * 들여쓰기. 색을 포인트 컬러로 주지 않는 이유는 `--ui-selection` 계열이 흰 글자를
         * 얹으라고 만든 진한 톤이라 다크 모드 카드 배경 위에서 대비가 무너지기 때문이다.
         */}
        <span className="text-[15px] font-bold whitespace-nowrap text-muted-foreground">
          {title}
        </span>
        <span className="rounded-full bg-ui-list-hover px-1.5 text-[11px] font-bold text-muted-foreground">
          {count}
        </span>
      </button>
    </div>
  )
}

/**
 * IntelliJ 의 Commit 툴윈도우 왼쪽 — Changes(추적 중인 파일)와 Unversioned Files
 * (아직 버전 관리에 없는 파일)를 나눠 보여 주고, 체크한 것이 커밋 대상이 된다.
 */
export function ChangeList({
  status,
  checked,
  activePath,
  onCheck,
  onCheckMany,
  onActivate,
  onAction,
}: {
  status: GitStatus
  checked: Set<string>
  activePath: string | null
  onCheck: (path: string, on: boolean) => void
  onCheckMany: (paths: string[], on: boolean) => void
  onActivate: (change: GitChange) => void
  onAction: (action: ChangeAction, change: GitChange) => void
}) {
  const [openChanges, setOpenChanges] = useState(true)
  const [openUntracked, setOpenUntracked] = useState(true)
  const [menu, setMenu] = useState<MenuState | null>(null)

  const sections: {
    key: string
    title: string
    items: GitChange[]
    open: boolean
    setOpen: (v: boolean) => void
  }[] = [
    {
      key: "changes",
      title: "Changes",
      items: status.changes,
      open: openChanges,
      setOpen: setOpenChanges,
    },
    {
      key: "untracked",
      title: "Unversioned Files",
      items: status.untracked,
      open: openUntracked,
      setOpen: setOpenUntracked,
    },
  ]

  if (!status.changes.length && !status.untracked.length) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-[13px] text-muted-foreground">
        변경된 파일이 없습니다.
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto py-1">
      {/*
       * 파일명은 자르지 않고(`whitespace-nowrap`) 가로로 넘치게 둔다 — 긴 경로가 잘리면
       * 어느 파일인지 알 수 없어 목록의 쓸모가 사라진다. 그 대신 이 래퍼가 `w-max` 로
       * 가장 긴 행만큼 넓어져 바깥 컨테이너에 가로 스크롤이 생기고, `min-w-full` 이
       * 짧은 목록에서도 행이 패널 폭을 채우게 해(hover·선택 배경이 끊기지 않게) 한다.
       */}
      <div className="w-max min-w-full">
        {sections.map((s, i) => {
          const paths = s.items.map((c) => c.path)
          const on = paths.filter((p) => checked.has(p)).length
          return (
            // 그룹 사이는 선이 아니라 간격으로 끊는다(Slack 규칙).
            <div key={s.key} className={cn("pb-1", i > 0 && "pt-2")}>
              <SectionHeader
                title={s.title}
                count={s.items.length}
                open={s.open}
                allChecked={paths.length > 0 && on === paths.length}
                someChecked={on > 0}
                onToggleOpen={() => s.setOpen(!s.open)}
                onCheckAll={(v) => onCheckMany(paths, v)}
              />
              {s.open &&
                s.items.map((c) => (
                  <ChangeRow
                    key={c.path}
                    change={c}
                    checked={checked.has(c.path)}
                    active={activePath === c.path}
                    onCheck={(v) => onCheck(c.path, v)}
                    onActivate={() => onActivate(c)}
                    onMenu={(e) => {
                      e.preventDefault()
                      onActivate(c)
                      setMenu({ x: e.clientX, y: e.clientY, change: c })
                    }}
                  />
                ))}
            </div>
          )
        })}
      </div>
      {/* 메뉴는 `fixed` 라 스크롤 래퍼 밖에 두어야 가로 스크롤을 따라 밀리지 않는다. */}
      {menu && (
        <ContextMenu
          state={menu}
          onClose={() => setMenu(null)}
          onAction={onAction}
        />
      )}
    </div>
  )
}
