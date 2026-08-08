import { CalendarIcon, CalendarDaysIcon, RefreshCwIcon } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { trackedInvoke } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { suppressWebviews } from "@/lib/webview-overlay"

import { friendlyError } from "./gcal-error"
import { WeekSection } from "./gcal-shared"
import { PILL, splitByWeek } from "./gcal-util"
import { useGcalConnection, type CalendarEvent } from "./use-gcal"

/**
 * 상단바 왼쪽의 **내 일정**.
 *
 * 구성원 일정 검색이 "남의 일정" 을 보는 창이라면 이것은 같은 자리에서 **내 캘린더**를
 * 보는 창이다 — 누르면 primary 캘린더의 이번주·다음주 일정(`gcal_upcoming`)을 그대로
 * 펼친다. 캘린더 뷰의 '내 일정' 탭과 같은 백엔드이고, 표시도 같은 `WeekSection` 이다.
 *
 * `useGcal()` 을 쓰지 않는 이유는 **폴링** 이다. 그 훅은 `useTabActive()` 로 주기 조회를
 * 게이트하는데 상단바는 늘 마운트돼 있어 그 게이트가 항상 `true` 다 — 앱을 켜 둔 내내
 * 5분마다 호출이 나간다. 회의실 예약 팔레트와 같은 판단으로, **열 때 한 번만** 부르고
 * 새로고침은 사용자가 직접 누른다.
 */
export function MySchedulePalette() {
  const [open, setOpen] = useState(false)
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rootRef = useRef<HTMLDivElement>(null)
  /** 이번에 열려 있는 동안 이미 불러왔는지(닫으면 풀린다). */
  const loadedRef = useRef(false)

  const { status } = useGcalConnection()
  const connected = status?.connected === true

  // 바깥을 누르면 닫는다(다른 상단바 팔레트와 같은 방식).
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener("pointerdown", onDown)
    return () => window.removeEventListener("pointerdown", onDown)
  }, [open])

  // 드롭다운은 네이티브 웹뷰(브라우저 등) 위로 내려오는데, 웹뷰는 창 위에 겹쳐 그려져
  // CSS 로 가려지지 않는다. 열려 있는 동안만 웹뷰 숨김을 요청한다(탭 넘침 목록과 같은 방식).
  useEffect(() => {
    if (!open) return
    return suppressWebviews()
  }, [open])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setEvents(await trackedInvoke<CalendarEvent[]>("gcal_upcoming"))
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  /**
   * 열려 있고 연결이 확인되면 한 번 불러온다.
   *
   * 여는 순간에 바로 부르지 않는 이유는 `gcal_status` 가 아직 도착하지 않았을 수 있어서다
   * (앱을 켜자마자 누른 경우). 그때 조회를 건너뛰면 연결돼 있는데도 빈 화면이 남는다.
   */
  useEffect(() => {
    if (!open) {
      loadedRef.current = false
      return
    }
    if (!connected || loadedRef.current) return
    loadedRef.current = true
    void load()
  }, [open, connected, load])

  const { thisWeek, nextWeek } = splitByWeek(events)

  return (
    <div ref={rootRef} className="relative shrink-0">
      {/* 상단바 알약 — 구성원 검색·회의실 예약과 같은 톤·폭. 드래그 영역으로 만들지 않는다. */}
      <button
        type="button"
        aria-label="내 일정"
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-[150px] cursor-pointer items-center gap-2 rounded-full border border-ui-chrome-fg/20 bg-ui-chrome-hover px-3 text-[13px] text-ui-chrome-muted-fg transition-colors hover:bg-ui-chrome-active"
      >
        <CalendarDaysIcon className="size-3.5 shrink-0" />
        <span className="truncate">내 일정</span>
      </button>

      {/* 드롭다운은 알약 왼쪽에 맞춰 펼친다 — 가운데 정렬(구성원 검색)이나 오른쪽
          정렬(회의실 예약)로 두면 창이 좁을 때 셋 중 가장 왼쪽인 이 드롭다운이 창 밖으로
          밀려난다. */}
      {open && (
        <div className="absolute top-full left-0 z-[100] mt-1 flex max-h-[72vh] w-[min(560px,92vw)] flex-col overflow-hidden rounded-[10px] border border-border bg-card text-foreground shadow-[0_4px_16px_rgba(0,0,0,0.16)]">
          {status === null ? (
            // 연결 상태를 아직 모른다 — 미연결로 단정하면 잠깐 틀린 안내가 뜬다.
            <p className="px-3 py-8 text-center text-[13px] text-muted-foreground">
              연결 상태를 확인하는 중…
            </p>
          ) : !connected ? (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <CalendarIcon className="size-8 text-muted-foreground" />
              <p className="text-[15px] font-bold">
                Google 캘린더가 연결되지 않았습니다.
              </p>
              <p className="text-[13px] text-muted-foreground">
                설정 → Google Calendar 에서 계정을 연결하면 내 일정을 볼 수
                있습니다.
              </p>
            </div>
          ) : (
            <>
              {/* 어느 계정의 일정인지 + 직접 새로고침(폴링이 없으므로 이 버튼이 유일한 갱신 수단이다). */}
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <CalendarDaysIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="shrink-0 text-[15px] font-bold">내 일정</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                  {status.email ?? ""}
                </span>
                <Button
                  variant="ghost"
                  className={cn(PILL, "shrink-0")}
                  onClick={() => void load()}
                  disabled={loading}
                  aria-label="내 일정 새로고침"
                >
                  <RefreshCwIcon
                    className={cn("size-3.5", loading && "animate-spin")}
                  />
                </Button>
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
                {error ? (
                  <p className="px-1 py-2 text-[13px] text-ui-error">
                    {friendlyError(error)}
                  </p>
                ) : loading && events.length === 0 ? (
                  <p className="px-1 py-8 text-center text-[13px] text-muted-foreground">
                    일정을 불러오는 중…
                  </p>
                ) : (
                  <>
                    <WeekSection title="이번주" events={thisWeek} />
                    <WeekSection title="다음주" events={nextWeek} />
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
