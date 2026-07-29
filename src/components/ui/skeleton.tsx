import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      // Slack 기본 라운드(8px)에 맞춘다. 아바타 자리처럼 원형이 필요하면 호출 쪽에서 덧붙인다.
      className={cn("animate-pulse rounded-lg bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
