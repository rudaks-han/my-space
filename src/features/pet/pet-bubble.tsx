import { BellRingIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { ClaudeBrandIcon } from "@/components/brand-icons"
import { trackedInvoke } from "@/lib/tauri"
import type { PetNotice, PetNoticeAction } from "./use-pet-mood"

/**
 * 한 번에 쌓아 보여 줄 알림 개수. 동시에 대여섯 개가 걸리는 일은 드물지만,
 * 제한이 없으면 말풍선이 화면 높이를 채우고 그만큼 뒤 창의 클릭도 막는다
 * (펫 창은 내용 크기만큼 잡히므로 목록 길이가 곧 가려지는 면적이다).
 * 넘치는 건 마지막 줄에 개수로 알리고 My Space 창에서 보게 한다.
 */
const MAX_VISIBLE = 4

/** 말풍선 폭 — 이 값이 없으면 문장 길이에 따라 창이 화면을 가로지른다. */
const BUBBLE_W = "w-[248px]"

/**
 * 캐릭터 머리 위 알림 목록. 알림이 둘 이상이면 모두 쌓아 보여 준다 —
 * 하나만 남기면 "어느 작업 얘기인지" 를 알 수 없어 알림 자체가 쓸모없어진다.
 *
 * 각 줄은 작업목록 카드(claude-tasks-card)와 같은 구성이다:
 * 출처(아이콘 + 이름) + 상태 칩 / 굵은 작업 이름 / 옅은 상세.
 * 줄을 누르면 그 작업의 터미널로 이동한다.
 */
export function PetBubble({ notices }: { notices: PetNotice[] }) {
  const visible = notices.slice(0, MAX_VISIBLE)
  const hidden = notices.length - visible.length

  return (
    <div className={cn("pet-bubble flex flex-col gap-1.5", BUBBLE_W)}>
      {visible.map((n, i) => (
        <NoticeCard
          key={n.id}
          notice={n}
          // 꼬리는 캐릭터에 가장 가까운 마지막 카드에만 붙인다.
          withTail={i === visible.length - 1 && hidden === 0}
        />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => void trackedInvoke("show_main_window")}
          className="relative cursor-pointer rounded-[10px] bg-background px-2.5 py-1.5 text-[13px] font-bold text-ui-link shadow-[0_4px_16px_rgba(0,0,0,0.16)] transition-colors hover:bg-ui-list-hover"
        >
          {hidden}개 더 보기
          <Tail />
        </button>
      )}
    </div>
  )
}

/**
 * 알림 한 줄.
 *
 * 카드 몸통이 버튼이고 그 **아래에 버튼 줄이 따로** 붙는 구조다(버튼 안에 버튼을 넣을 수
 * 없어서). 버튼 줄은 선택이 필요한 알림 — 지금은 리마인더(확인·다시 알림)만 갖는다.
 */
function NoticeCard({
  notice,
  withTail,
}: {
  notice: PetNotice
  withTail: boolean
}) {
  const { source, sourceName, chip, title, detail, action, actions } = notice

  return (
    <div className="relative flex flex-col rounded-[10px] bg-background text-left shadow-[0_4px_16px_rgba(0,0,0,0.16)]">
      {/* 호버 배경이 카드 모서리를 넘지 않도록 같은 반경을 준다 — overflow-hidden 은 쓸 수 없다
          (말풍선 꼬리가 카드 밖으로 나가 있어서 잘린다). */}
      <button
        type="button"
        onClick={() =>
          action ? action() : void trackedInvoke("show_main_window")
        }
        className={cn(
          "flex cursor-pointer flex-col rounded-t-[10px] px-2.5 py-2 text-left transition-colors hover:bg-ui-list-hover",
          actions.length === 0 && "rounded-b-[10px]"
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <SourceIcon source={source} />
          <span className="truncate text-[11px] font-bold text-muted-foreground">
            {sourceName}
          </span>
          <span
            className={cn("inline-flex shrink-0 items-center", chip.className)}
          >
            {chip.text}
          </span>
        </span>

        {/* 어떤 작업에 대한 알림인지 — 작업목록과 같은 굵은 이름. */}
        <span className="mt-1 line-clamp-2 text-[13px] leading-snug font-bold text-foreground">
          {title}
        </span>

        {detail && (
          <span className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-muted-foreground">
            {detail}
          </span>
        )}
      </button>

      {actions.length > 0 && <ActionRow actions={actions} />}

      {withTail && <Tail />}
    </div>
  )
}

/** 카드 아래 버튼 줄 — 미루기(테두리)들 다음에 확인(채운 색)이 온다. */
function ActionRow({ actions }: { actions: PetNoticeAction[] }) {
  return (
    <div className="flex items-center justify-end gap-1 border-t px-2 py-1.5">
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          onClick={a.run}
          className={cn(
            "cursor-pointer rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors",
            a.primary
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "border text-muted-foreground hover:bg-ui-list-hover"
          )}
        >
          {a.label}
        </button>
      ))}
    </div>
  )
}

/** 출처 아이콘 — Claude 는 실제 브랜드 로고, 리마인더는 벨. */
function SourceIcon({ source }: { source: PetNotice["source"] }) {
  if (source === "reminder") {
    return <BellRingIcon className="size-3.5 shrink-0 text-ui-error" />
  }
  return <ClaudeBrandIcon className="size-3.5 shrink-0" />
}

/** 아래(캐릭터)를 향한 말풍선 꼬리 — 배경색 사각형을 45° 돌려 붙인다. */
function Tail() {
  return (
    <span className="absolute -bottom-[4px] left-1/2 size-[9px] -translate-x-1/2 rotate-45 rounded-[1px] bg-background" />
  )
}
