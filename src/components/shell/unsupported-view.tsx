import { BanIcon } from "lucide-react"

import { PLATFORM } from "@/lib/platform"

/** 안내문에 쓸 OS 이름. */
const OS_LABEL: Record<string, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
}

interface UnsupportedViewProps {
  /** 메뉴 이름(= 탭 제목과 같은 것). */
  title: string
  /** 왜 못 쓰는지 — `menus.tsx` 의 `unsupported.reason`. */
  reason: string
}

/**
 * 이 OS 에서 쓸 수 없는 메뉴를 열었을 때 원래 뷰 대신 그리는 안내 패널.
 *
 * 사이드바에서 클릭 자체를 막지 않는 이유: 눌리지 않는 항목은 "고장 났나" 로 읽힌다.
 * 열리되 왜 안 되는지 말해 주는 편이 낫고, 실제 뷰는 마운트되지 않으므로
 * 뒤에서 실패할 폴링이 돌지도 않는다(`view-info.tsx` 에서 갈아 끼운다).
 */
export function UnsupportedView({ title, reason }: UnsupportedViewProps) {
  const os = OS_LABEL[PLATFORM] ?? PLATFORM

  return (
    <div className="flex h-full items-center justify-center">
      <div className="w-full max-w-[520px] rounded-[10px] border border-border bg-card p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <div className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-[10px] bg-muted text-muted-foreground">
            <BanIcon className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[18px] font-bold tracking-[-0.01em]">
              {title}
            </p>
            <p className="text-[13px] text-muted-foreground">
              {os} 에서는 사용할 수 없습니다
            </p>
          </div>
        </div>

        <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
          {reason}
        </p>
      </div>
    </div>
  )
}
