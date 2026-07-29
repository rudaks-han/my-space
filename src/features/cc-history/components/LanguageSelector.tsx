import { useEffect, useRef, useState } from "react"
import { Globe, ChevronDown, Check } from "lucide-react"
import { useI18n, type Lang } from "../i18n-context"
import { cn } from "@/lib/utils"

const OPTIONS: { value: Lang; label: string; short: string }[] = [
  { value: "en", label: "English", short: "EN" },
  { value: "ko", label: "한국어", short: "KO" },
]

export function LanguageSelector() {
  const { lang, setLang } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDocClick)
    return () => document.removeEventListener("mousedown", onDocClick)
  }, [open])

  const current = OPTIONS.find((o) => o.value === lang) ?? OPTIONS[0]

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2 text-xs transition-colors hover:bg-accent"
      >
        <Globe className="h-3.5 w-3.5" />
        <span className="font-medium">{current.short}</span>
        <ChevronDown
          className={cn("h-3 w-3 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="absolute top-full right-0 z-50 mt-1 min-w-[140px] rounded-md border border-border bg-popover p-1 shadow-md">
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => {
                setLang(o.value)
                setOpen(false)
              }}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent",
                o.value === lang && "text-brand"
              )}
            >
              <span>{o.label}</span>
              {o.value === lang && <Check className="h-3 w-3" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
