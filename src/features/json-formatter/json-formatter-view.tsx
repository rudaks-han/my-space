import { BracesIcon } from "lucide-react"

/**
 * JSON 포맷터 — 자리만 잡아 둔 상태(기능은 추후 구현).
 * 입력 JSON 을 정렬/검증해 보여 주는 화면이 될 예정이다.
 */
export function JsonFormatterView() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 rounded-[10px] border border-border bg-card p-8 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      {/* 아이콘은 Slack 아바타처럼 둥근 사각 타일 안에 넣는다. */}
      <span className="flex size-12 items-center justify-center rounded-[10px] bg-muted">
        <BracesIcon className="size-6 text-muted-foreground" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-[15px] font-bold">JSON 포맷터</p>
        <p className="text-[13px] text-muted-foreground">
          아직 준비 중입니다. 기능은 추후 구현 예정입니다.
        </p>
      </div>
    </div>
  )
}
