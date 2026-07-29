import {
  CalendarIcon,
  ClockIcon,
  DoorOpenIcon,
  RefreshCwIcon,
  UsersIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useLocalStorage } from "@/lib/use-local-storage"
import { cn } from "@/lib/utils"

import { friendlyError } from "./gcal-error"
import { WeekSection } from "./gcal-shared"
import { PILL, splitByWeek } from "./gcal-util"
import { PeopleView } from "./people-view"
import { RoomsView } from "./rooms-view"
import { useGcal, useGcalConnection } from "./use-gcal"

/** 캘린더 뷰 안 서브탭(내 일정 / 회의실) 선택 저장 키. */
const SUBTAB_KEY = "myspace.gcalSubTab"

/** 아직 계정이 연결되지 않았을 때 — 연결은 설정 화면에서 한다. */
function NotConnectedView() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
      <CalendarIcon className="size-9 text-muted-foreground" />
      <p className="text-[15px] font-bold">
        Google 캘린더가 연결되지 않았습니다.
      </p>
      <p className="text-[13px] text-muted-foreground">
        사이드바 아래 톱니 아이콘 → 설정 → Google Calendar 에서 계정을 연결해
        주세요.
      </p>
    </div>
  )
}

/** 내 일정 — 이번주·다음주를 주 단위로 나눠 보여준다. */
function MySchedulePanel() {
  const { status, events, loading, error, updatedAt, refresh } =
    useGcal("upcoming")
  const { thisWeek, nextWeek } = splitByWeek(events)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <CalendarIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-[15px] font-bold">이번주 · 다음주 일정</span>
        <span className="text-[13px] text-muted-foreground">
          {status?.email ?? "Google 캘린더"}
          {updatedAt &&
            ` · ${new Date(updatedAt).toLocaleTimeString("ko-KR", {
              hour: "2-digit",
              minute: "2-digit",
            })} 업데이트`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            className={PILL}
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCwIcon
              className={cn("size-3.5", loading && "animate-spin")}
            />
            새로고침
          </Button>
        </div>
      </div>

      {error && (
        <p className="rounded-lg bg-ui-error/15 px-3 py-2 text-[15px] text-ui-error">
          {friendlyError(error)}
        </p>
      )}

      {loading && events.length === 0 ? (
        <div className="flex flex-1 items-center justify-center py-16 text-[15px] text-muted-foreground">
          일정을 불러오는 중…
        </div>
      ) : events.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
          <ClockIcon className="size-9 text-muted-foreground" />
          <p className="text-[15px] text-muted-foreground">
            이번주·다음주 예정된 일정이 없습니다.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <WeekSection title="이번주" events={thisWeek} />
          <WeekSection title="다음주" events={nextWeek} />
        </div>
      )}
    </div>
  )
}

export function GcalView() {
  const [tab, setTab] = useLocalStorage<string>(SUBTAB_KEY, "mine")
  const { status } = useGcalConnection()

  if (status === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-[15px] text-muted-foreground">
        연결 상태 확인 중…
      </div>
    )
  }

  if (!status.connected) {
    return <NotConnectedView />
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
      <Tabs value={tab} onValueChange={(v) => setTab(v as string)}>
        <TabsList className="w-full">
          <TabsTrigger value="mine">
            <CalendarIcon />내 일정
          </TabsTrigger>
          <TabsTrigger value="people">
            <UsersIcon />
            전체 일정
          </TabsTrigger>
          <TabsTrigger value="rooms">
            <DoorOpenIcon />
            회의실
          </TabsTrigger>
        </TabsList>
        {/* base-ui Panel 은 비활성 시 언마운트 → 회의실 폴링이 내 일정 볼 때 돌지 않는다. */}
        <TabsContent value="mine">
          <MySchedulePanel />
        </TabsContent>
        <TabsContent value="people">
          <PeopleView />
        </TabsContent>
        <TabsContent value="rooms">
          <RoomsView />
        </TabsContent>
      </Tabs>
    </div>
  )
}
