import { useMemo, useState } from "react"
import { BellIcon, BellOffIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import {
  useReminders,
  type Reminder,
  type ReminderRepeat,
} from "./use-reminders"

const REPEATS: { key: ReminderRepeat; label: string }[] = [
  { key: "once", label: "한 번" },
  { key: "daily", label: "매일" },
]

/** datetime-local 기본값: 현재 시각 + 5분(로컬), "YYYY-MM-DDTHH:MM". */
function defaultDateTime() {
  const d = new Date(Date.now() + 5 * 60_000)
  d.setSeconds(0, 0)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 목록에 표시할 예정 시각 문구. */
function scheduleText(r: Reminder) {
  if (r.repeat === "daily") return `매일 ${r.time}`
  return new Date(r.at).toLocaleString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

/** 한 번짜리 알림이 이미 울렸는지. */
function isFiredOnce(r: Reminder) {
  return r.repeat === "once" && r.firedAt != null
}

export function ReminderView() {
  const { reminders, add, toggle, remove } = useReminders()
  const [title, setTitle] = useState("")
  const [repeat, setRepeat] = useState<ReminderRepeat>("once")
  const [at, setAt] = useState(defaultDateTime)
  const [time, setTime] = useState("09:00")

  const activeCount = useMemo(
    () => reminders.filter((r) => r.enabled && !isFiredOnce(r)).length,
    [reminders]
  )

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    add({ title, repeat, at, time })
    setTitle("")
    setAt(defaultDateTime())
  }

  return (
    <div className="mx-auto w-full max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>알림</CardTitle>
          <CardDescription>
            예정된 알림 {activeCount}개 · 시간이 되면 메뉴바 팝오버로
            알려줍니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form className="flex flex-col gap-3" onSubmit={submit}>
            <Input
              placeholder="알림 내용을 입력하세요"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />

            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">반복</Label>
                <div className="flex gap-1">
                  {REPEATS.map((r) => (
                    <Button
                      key={r.key}
                      type="button"
                      size="sm"
                      variant={repeat === r.key ? "secondary" : "ghost"}
                      onClick={() => setRepeat(r.key)}
                    >
                      {r.label}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">
                  {repeat === "daily" ? "매일 이 시각" : "예정 일시"}
                </Label>
                {repeat === "daily" ? (
                  <Input
                    type="time"
                    className="w-36"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                  />
                ) : (
                  <Input
                    type="datetime-local"
                    className="w-56"
                    value={at}
                    onChange={(e) => setAt(e.target.value)}
                  />
                )}
              </div>

              <Button type="submit" disabled={!title.trim()}>
                추가
              </Button>
            </div>
          </form>

          <ul className="flex flex-col gap-1.5">
            {reminders.length === 0 && (
              <li className="py-8 text-center text-sm text-muted-foreground">
                등록된 알림이 없습니다.
              </li>
            )}
            {reminders.map((r) => {
              const fired = isFiredOnce(r)
              const dimmed = !r.enabled || fired
              return (
                <li
                  key={r.id}
                  className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 transition-colors hover:bg-muted/40"
                >
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => toggle(r.id)}
                    aria-label={r.enabled ? "알림 끄기" : "알림 켜기"}
                    title={r.enabled ? "알림 끄기" : "알림 켜기"}
                    className={
                      r.enabled ? "text-foreground" : "text-muted-foreground"
                    }
                  >
                    {r.enabled ? <BellIcon /> : <BellOffIcon />}
                  </Button>

                  <div className="flex min-w-0 flex-1 flex-col">
                    <span
                      className={cn(
                        "truncate text-sm",
                        dimmed && "text-muted-foreground line-through"
                      )}
                    >
                      {r.title}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {scheduleText(r)}
                      {fired && " · 완료"}
                    </span>
                  </div>

                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => remove(r.id)}
                    aria-label="삭제"
                  >
                    <Trash2Icon />
                  </Button>
                </li>
              )
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
