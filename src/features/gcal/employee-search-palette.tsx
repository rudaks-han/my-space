import { CalendarIcon, EyeOffIcon, SearchIcon, UsersIcon, XIcon } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { Input } from "@/components/ui/input"
import { trackedInvoke } from "@/lib/tauri"
import { cn } from "@/lib/utils"

import { friendlyError } from "./gcal-error"
import { WeekSection } from "./gcal-shared"
import { splitByWeek } from "./gcal-util"
import {
  useGcalConnection,
  useGcalPeople,
  type Person,
  type PersonSchedule,
} from "./use-gcal"

/** 한 번에 그리는 검색 결과 수 — 주소록은 수천 명일 수 있다. */
const MAX_RESULTS = 30

/** 검색어 매칭 — 이름과 이메일 양쪽을 본다. */
function matches(p: Person, q: string): boolean {
  return p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)
}

/** 공개 범위 때문에 반쪽만 보이는 경우를 일정 위에 한 줄로 알린다. */
function AccessNotice({ schedule }: { schedule: PersonSchedule }) {
  if (schedule.access === "full") return null
  if (schedule.access === "busy") {
    return (
      <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
        <EyeOffIcon className="size-3.5 shrink-0" />
        캘린더 공개 범위가 ‘한가함/바쁨’ 이라 제목 없이 시간만 표시됩니다.
      </p>
    )
  }
  return (
    <p className="rounded-lg bg-ui-warning/15 px-3 py-2 text-[13px] text-ui-warning">
      일정을 볼 수 없습니다 — 이 구성원이 캘린더를 공개하지 않았습니다.
      {schedule.error ? ` (${friendlyError(schedule.error)})` : ""}
    </p>
  )
}

/**
 * 상단바 가운데의 **구성원 일정 빠른 검색**.
 *
 * 사이드바를 접어 두어도 상단바는 늘 보이므로, 여기서 이름만 입력하면 그 구성원의
 * 이번주·다음주 일정(회의·휴가·외근 전부)을 바로 아래 드롭다운에서 확인할 수 있다.
 * 구글 캘린더 연동(도메인 주소록 + `gcal_person_events`)을 그대로 재사용한다 —
 * 캘린더 뷰의 '전체 일정' 탭과 같은 백엔드다.
 *
 * 검색창은 늘 위에 고정된다 — 한 사람의 일정을 본 뒤에도 뒤로가기 없이 곧바로 다시
 * 입력해 다른 사람을 찾을 수 있고(고르면 검색어가 비워지고 일정이 뜬다), 결과는
 * ↓/↑ 로 옮겨 다니며 Enter 로 고른다.
 */
export function EmployeeSearchPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<Person | null>(null)
  const [schedule, setSchedule] = useState<PersonSchedule | null>(null)
  const [loading, setLoading] = useState(false)
  /** 키보드로 짚고 있는 결과 인덱스(↓/↑). */
  const [active, setActive] = useState(0)

  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)

  const { status } = useGcalConnection()
  const {
    people: directory,
    loading: dirLoading,
    error: dirError,
    load,
  } = useGcalPeople()

  const connected = status?.connected === true

  // 열릴 때 주소록을 한 번 받아 둔다(Rust 가 7일 캐시를 들고 있어 재호출도 싸다).
  useEffect(() => {
    if (open && connected && !directory) void load()
  }, [open, connected, directory, load])

  // 열리면 입력에 포커스를 준다 — 곧바로 타이핑할 수 있게.
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // 바깥을 누르면 닫는다.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener("pointerdown", onDown)
    return () => window.removeEventListener("pointerdown", onDown)
  }, [open])

  const q = query.trim().toLowerCase()
  // 주소록 전체를 매 글자마다 훑으므로 검색어가 바뀔 때만 다시 계산한다.
  const hits = useMemo(
    () => (q ? (directory ?? []).filter((p) => matches(p, q)) : []),
    [directory, q]
  )
  const shown = hits.slice(0, MAX_RESULTS)
  // 검색어가 있으면 결과를, 없고 고른 사람이 있으면 그 사람 일정을 보여준다.
  const searching = q.length > 0

  // 하이라이트가 목록 밖으로 스크롤되지 않게 따라가게 한다.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" })
  }, [active])

  async function pick(p: Person) {
    setSelected(p)
    setSchedule(null)
    setLoading(true)
    // 검색어를 비워 일정 화면으로 넘어가되, 포커스는 입력에 남겨 바로 다시 검색할 수 있게.
    setQuery("")
    inputRef.current?.focus()
    try {
      setSchedule(
        await trackedInvoke<PersonSchedule>("gcal_person_events", {
          email: p.email,
        })
      )
    } catch (e) {
      setSchedule({
        email: p.email,
        access: "denied",
        events: [],
        error: String(e),
      })
    } finally {
      setLoading(false)
    }
  }

  function reset() {
    setOpen(false)
    setSelected(null)
    setSchedule(null)
    setQuery("")
  }

  // 입력창 위에서의 키보드 조작 — ↓/↑ 로 결과 이동, Enter 로 선택, Esc 로 닫기.
  function onInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault()
      reset()
      return
    }
    if (!searching || shown.length === 0) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, shown.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const p = shown[active]
      if (p) void pick(p)
    }
  }

  const { thisWeek, nextWeek } = splitByWeek(schedule?.events ?? [])

  return (
    <div
      ref={rootRef}
      className="absolute top-1/2 left-1/2 z-50 w-[min(420px,45%)] -translate-x-1/2 -translate-y-1/2"
    >
      {/* 상단바 검색 알약 — Slack 의 "Search …" 자리. 드래그 영역으로 만들지 않는다. */}
      <button
        type="button"
        aria-label="구성원 일정 검색"
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-full border border-ui-chrome-fg/20 bg-ui-chrome-hover px-3 text-[13px] text-ui-chrome-muted-fg transition-colors hover:bg-ui-chrome-active"
      >
        <SearchIcon className="size-3.5 shrink-0" />
        <span className="truncate">구성원 일정 검색</span>
      </button>

      {open && (
        <div className="absolute top-full left-1/2 z-[100] mt-1 flex max-h-[72vh] w-[min(640px,92vw)] -translate-x-1/2 flex-col overflow-hidden rounded-[10px] border border-border bg-card text-foreground shadow-[0_4px_16px_rgba(0,0,0,0.16)]">
          {!connected ? (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <CalendarIcon className="size-8 text-muted-foreground" />
              <p className="text-[15px] font-bold">
                Google 캘린더가 연결되지 않았습니다.
              </p>
              <p className="text-[13px] text-muted-foreground">
                설정 → Google Calendar 에서 계정을 연결하면 구성원 일정을 검색할
                수 있습니다.
              </p>
            </div>
          ) : (
            <>
              {/* 늘 고정된 검색 입력 — 사람을 고른 뒤에도 여기 바로 입력해 다른 사람을 찾는다. */}
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
                <Input
                  ref={inputRef}
                  className="h-8 border-0 px-0 shadow-none focus-visible:ring-0"
                  placeholder="이름 또는 이메일로 구성원 검색"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    // 검색어가 바뀌면 하이라이트를 맨 위로 되돌린다.
                    setActive(0)
                  }}
                  onKeyDown={onInputKeyDown}
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("")
                      inputRef.current?.focus()
                    }}
                    aria-label="검색어 지우기"
                    className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-ui-list-hover"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                )}
              </div>

              {searching ? (
                // 구성원 검색 결과 — ↓/↑ 로 이동, Enter/클릭으로 선택.
                <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
                  {dirError ? (
                    <p className="px-3 py-2 text-[13px] text-ui-error">
                      {friendlyError(dirError)}
                    </p>
                  ) : dirLoading && !directory ? (
                    <p className="px-3 py-2 text-[13px] text-muted-foreground">
                      주소록을 불러오는 중…
                    </p>
                  ) : shown.length === 0 ? (
                    <p className="px-3 py-2 text-[13px] text-muted-foreground">
                      검색 결과가 없습니다.
                    </p>
                  ) : (
                    shown.map((p, i) => (
                      <button
                        key={p.email}
                        ref={i === active ? activeRef : undefined}
                        type="button"
                        onClick={() => void pick(p)}
                        onMouseMove={() => setActive(i)}
                        className={cn(
                          "flex min-h-9 items-center gap-3 rounded-lg px-3 py-1.5 text-left text-[15px] transition-colors",
                          i === active ? "bg-ui-list-hover" : "hover:bg-ui-list-hover"
                        )}
                      >
                        <UsersIcon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate font-semibold">
                          {p.name}
                        </span>
                        <span className="min-w-0 shrink truncate text-[13px] text-muted-foreground">
                          {p.email}
                        </span>
                      </button>
                    ))
                  )}
                  {hits.length > shown.length && (
                    <p className="px-3 py-2 text-[13px] text-muted-foreground">
                      {hits.length - shown.length}명 더 있습니다 — 검색어를 좁혀
                      주세요.
                    </p>
                  )}
                </div>
              ) : selected ? (
                // 고른 구성원의 이번주·다음주 일정.
                <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <UsersIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="shrink-0 text-[15px] font-bold">
                      {selected.name}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                      {selected.email}
                    </span>
                  </div>
                  <div className="flex flex-col gap-3 px-3 pb-3">
                    {loading ? (
                      <p className="px-1 py-8 text-center text-[13px] text-muted-foreground">
                        일정을 불러오는 중…
                      </p>
                    ) : (
                      schedule && (
                        <>
                          <AccessNotice schedule={schedule} />
                          {schedule.access !== "denied" && (
                            <>
                              <WeekSection title="이번주" events={thisWeek} />
                              <WeekSection title="다음주" events={nextWeek} />
                            </>
                          )}
                        </>
                      )
                    )}
                  </div>
                </div>
              ) : (
                <p className="px-3 py-8 text-center text-[13px] text-muted-foreground">
                  구성원 이름을 입력하면 그 사람의 회의·휴가·외근 일정을
                  보여줍니다.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
