/**
 * "모두 중지" 확인 레이어 — 서비스를 내리는 세 자리가 이것을 공유한다.
 *
 * 한 번의 클릭으로 띄워 둔 서비스가 **전부** 내려가는데, 되돌리는 방법은 하나씩 다시
 * 띄우는 것뿐이다(부팅에 수십 초씩 걸린다). 게다가 세 자리 중 둘은 아이콘 하나라
 * (Cowork 개발 화면 툴바의 ■, 독 헤더의 알약) 옆 버튼을 노리다 잘못 누르기 쉽다.
 *
 * 그래서 묻되, **무엇이 내려가는지 이름으로 보여 준다** — "3개를 중지할까요?" 만으로는
 * 방금 띄운 것이 그 안에 드는지 알 수 없어 확인이 형식이 된다. 웹뷰의 `confirm()` 을
 * 쓰지 않는 이유는 이 앱의 다른 대화창과 같다(네이티브 모달이라 화면과 따로 논다).
 */

import { useEffect } from "react"
import { SquareIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { Service } from "./use-services"

export function StopAllDialog({
  targets,
  onCancel,
  onConfirm,
}: {
  /** 실제로 내려갈 서비스들(`api.stoppableRunning`). 비어 있으면 열리지 않는다. */
  targets: Service[]
  onCancel: () => void
  onConfirm: () => void
}) {
  // Esc 로 닫는다 — 실수로 연 대화창을 마우스까지 옮겨 취소하게 두지 않는다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onCancel])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-sm flex-col gap-3 rounded-[10px] border border-border bg-card p-4 shadow-[0_4px_16px_rgba(0,0,0,0.16)]"
      >
        <div className="text-[18px] font-bold tracking-[-0.01em]">
          실행 중인 서비스를 모두 중지할까요?
        </div>
        <p className="text-[13px] text-muted-foreground">
          아래{" "}
          <span className="font-bold text-foreground">{targets.length}개</span>{" "}
          서비스를 종료합니다. IntelliJ 정지 버튼과 같은 SIGINT(graceful
          shutdown) 입니다.
        </p>

        {/* 목록이 길어도 대화창이 화면을 넘지 않도록 여기만 스크롤한다.
            ui-selectable: body 의 select-none 을 되돌린다 — 이름을 복사해 확인할 수 있어야 한다. */}
        <ul className="ui-selectable max-h-52 overflow-auto rounded-lg bg-muted/40 p-2">
          {targets.map((s) => (
            <li
              key={s.name}
              className="flex min-h-6 items-center gap-1.5 px-1 text-[13px]"
            >
              <span className="size-1.5 shrink-0 rounded-full bg-ui-success" />
              <span className="truncate">{s.name}</span>
            </li>
          ))}
        </ul>

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
            <SquareIcon className="fill-current" />
            모두 중지
          </Button>
        </div>
      </div>
    </div>
  )
}
