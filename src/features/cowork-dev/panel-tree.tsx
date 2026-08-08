import type { ComponentType, ReactNode } from "react"
import { ChevronDownIcon, ChevronRightIcon, SearchIcon } from "lucide-react"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/**
 * 오른쪽 인프라 패널이 함께 쓰는 줄 부품 — 데이터베이스 · Elasticsearch · Kafka 세 장이
 * 작은 아이콘 레일로 갈아 끼워지는 **한 자리**를 나눠 쓰기 때문에 존재한다.
 *
 * 부품을 빼낸 이유가 "중복 제거"가 아니라 **치수**라는 점이 중요하다. 세 패널은 같은
 * 280px 남짓한 칸에서 서로 교체되므로, 한쪽 줄이 22px 이고 다른 쪽이 30px 이면 레일을
 * 누를 때마다 목록이 위아래로 튀어 같은 패널의 다른 모드가 아니라 다른 화면처럼 보인다.
 * 그래서 줄 높이 · 글자 크기 · 화살표와 아이콘 자리 · 선택 색을 여기 한 곳에만 적는다
 * (원본은 `db-panel.tsx` 에 인라인으로 있던 것이고, 옮기면서 모양은 한 픽셀도 바꾸지 않았다).
 *
 * 여기 있는 것은 전부 **표시 전용**이다. 무엇을 열지·무엇을 고를지는 각 패널이 정하고,
 * 이 파일은 그것을 어떻게 그리는지만 안다 — 세 패널의 데이터 모양(스키마 트리 · 인덱스
 * 목록 · 토픽 목록)이 서로 전혀 달라서, 공통으로 뽑을 수 있는 것이 그 층뿐이다.
 */

/* ─────────────────────────── 머리줄 ─────────────────────────── */

/**
 * 패널 머리줄(30px). 왼쪽에 패널 이름, 나머지는 각 패널이 채운다.
 *
 * 이름은 **대문자 마이크로 라벨을 쓰지 않는다** — 이 앱의 금지 사항이라 한글 그대로 적는다.
 * 동작 버튼은 `children` 안에서 `ml-auto` 로 오른쪽에 붙인다(패널마다 개수가 달라서
 * 이 부품이 자리를 미리 나눠 두면 오히려 어긋난다).
 */
export function PanelHeader({
  label,
  children,
}: {
  label: string
  children?: ReactNode
}) {
  return (
    <div className="flex h-[30px] shrink-0 items-center gap-1 border-b border-border px-2">
      <span className="shrink-0 text-[11px] font-semibold text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  )
}

/** 목록 위의 검색 칸. 세 패널이 같은 자리·같은 높이(24px)에 둔다. */
export function PanelFilter({
  value,
  placeholder,
  onChange,
  disabled,
}: {
  value: string
  placeholder: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  return (
    <div className="relative">
      <SearchIcon className="absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 pl-7 text-[12px]"
      />
    </div>
  )
}

/* ─────────────────────────── 줄 ─────────────────────────── */

export interface PanelRowProps {
  depth: number
  expandable?: boolean
  expanded?: boolean
  onToggle?: () => void
  /** 아이콘 자리에 놓을 것. `leading` 을 주면 무시된다. */
  icon?: ComponentType<{ className?: string }>
  /**
   * 아이콘 대신 직접 그릴 것 — ES 인덱스의 health 점처럼 Lucide 아이콘이 아닌 표시를
   * 위한 구멍이다. 자리(폭)는 아이콘과 같아야 하므로 `size-3.5` 안에 들어가는 것만 넣는다.
   */
  leading?: ReactNode
  label: string
  title?: string
  right?: ReactNode
  selected?: boolean
  onClick?: () => void
}

/**
 * 트리·목록 한 줄. 왼쪽 트리(`FileTree`)와 같은 치수 — 22px 높이, 13px 글자, 화살표와
 * 아이콘 자리를 항상 비워 두어 깊이가 달라도 글자 왼쪽 끝이 어긋나지 않게 한다.
 *
 * 화살표는 `<button>` 안의 `<span>` 이다(버튼 안에 버튼은 못 넣는다). 그래서 접기는
 * `stopPropagation` 으로 갈라 낸다 — 폴더 줄은 어차피 눌러도 접히지만, 지금 고른
 * 스키마 줄은 "누르면 선택, 화살표만 누르면 접기"라 이 구분이 필요하다.
 */
export function PanelRow({
  depth,
  expandable,
  expanded,
  onToggle,
  icon: Icon,
  leading,
  label,
  title,
  right,
  selected,
  onClick,
}: PanelRowProps) {
  /* 아이콘 자리는 채울 것이 없어도 비워 두지 않는다 — 아이콘 없는 줄이 섞이면 그 줄만
     글자가 왼쪽으로 당겨져 목록이 들쭉날쭉해진다. */
  const lead =
    leading ??
    (Icon ? (
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          selected ? "text-ui-selection-fg/80" : "text-muted-foreground"
        )}
      />
    ) : (
      <span className="size-3.5 shrink-0" />
    ))

  return (
    <button
      type="button"
      title={title ?? label}
      onClick={onClick}
      style={{ paddingLeft: 4 + depth * 12 }}
      className={cn(
        "flex h-[22px] w-full items-center gap-1 rounded-lg pr-1.5 text-left text-[13px] transition-colors",
        selected
          ? "bg-ui-selection font-bold text-ui-selection-fg"
          : "hover:bg-ui-list-hover"
      )}
    >
      <span
        className="flex size-4 shrink-0 items-center justify-center"
        onClick={(e) => {
          if (!expandable) return
          e.stopPropagation()
          onToggle?.()
        }}
      >
        {expandable &&
          (expanded ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          ))}
      </span>
      {lead}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {right}
    </button>
  )
}

/** 폴더 줄 오른쪽의 개수 칩. */
export function PanelCount({ n }: { n: number }) {
  return (
    <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
      {n}
    </span>
  )
}

/**
 * 줄 오른쪽의 값 한 조각(문서 수 · 메시지 수 · 파티션 수).
 *
 * `PanelCount` 와 나눠 둔 이유: 이쪽은 **이미 서식이 정해진 문자열**을 그대로 받는다.
 * ES 는 `_cat/indices` 가 준 문자열을, Kafka 는 건수 대신 `p3` 같은 파티션 표기를 넣는데,
 * 칩(둥근 배경)으로 그리면 목록 절반이 칩으로 덮여 이름이 읽히지 않는다.
 */
export function PanelValue({
  children,
  title,
}: {
  children: ReactNode
  title?: string
}) {
  return (
    <span className="shrink-0 text-[11px] text-muted-foreground" title={title}>
      {children}
    </span>
  )
}

/** 트리 안의 안내 한 줄(빈 목록·읽는 중). 행 높이는 줄과 맞춘다. */
export function PanelNote({
  depth,
  children,
}: {
  depth: number
  children: ReactNode
}) {
  return (
    <p
      className="flex h-[22px] items-center text-[12px] text-muted-foreground"
      style={{ paddingLeft: 4 + depth * 12 + 20 }}
    >
      {children}
    </p>
  )
}

/**
 * 목록을 그릴 수 없을 때(등록된 접속이 없다 · 주소가 비어 있다)의 몸통.
 *
 * 아이콘을 인자로 받는다 — 세 패널이 각자 자기 브랜드 표시를 넣어야 하고, 여기에
 * 데이터베이스 아이콘을 박아 두면 Kafka 패널이 "데이터베이스가 없습니다"처럼 읽힌다.
 */
export function PanelEmpty({
  icon: Icon,
  title,
  desc,
  action,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  desc: string
  action: ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
      <span className="flex size-9 items-center justify-center rounded-[10px] bg-muted">
        <Icon className="size-4 text-muted-foreground" />
      </span>
      <p className="text-[13px] font-bold">{title}</p>
      <p className="text-[12px] text-muted-foreground">{desc}</p>
      {action}
    </div>
  )
}
