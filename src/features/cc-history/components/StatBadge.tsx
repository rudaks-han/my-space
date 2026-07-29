import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { useT } from "../i18n-context"

export function StatBadge({
  label,
  count,
  mainMap,
  subMap,
  className,
}: {
  label: string
  count: number
  mainMap: Record<string, number>
  subMap?: Record<string, number>
  className: string
}) {
  const t = useT()
  const allKeys = new Set([
    ...Object.keys(mainMap),
    ...Object.keys(subMap || {}),
  ])
  const rows = [...allKeys]
    .map((k) => ({ name: k, main: mainMap[k] || 0, sub: subMap?.[k] || 0 }))
    .sort((a, b) => b.main + b.sub - (a.main + a.sub))
  const hasSub = subMap && Object.keys(subMap).length > 0
  return (
    <div className="group relative">
      <Badge
        variant="outline"
        className={cn("cursor-default text-[10px]", className)}
      >
        {label} {count}
      </Badge>
      <div className="absolute top-full left-0 z-50 mt-1 hidden min-w-[180px] rounded-md border border-border bg-popover p-2 text-xs whitespace-nowrap shadow-md group-hover:block">
        {hasSub && (
          <div className="mb-1.5 border-b border-border pb-1 text-[9px] text-muted-foreground">
            {t("stat.mainSub")}
          </div>
        )}
        <div className="space-y-1">
          {rows.map(({ name, main, sub }) => (
            <div key={name} className="flex items-center justify-between gap-4">
              <span className="max-w-[200px] truncate text-muted-foreground">
                {name}
              </span>
              <span className="font-medium">
                {main}
                {sub > 0 && (
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    ({sub})
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
