import {
  CheckIcon,
  EyeOffIcon,
  RefreshCwIcon,
  SearchIcon,
  UsersIcon,
  XIcon,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useLocalStorage } from "@/lib/use-local-storage"
import { cn } from "@/lib/utils"

import { friendlyError } from "./gcal-error"
import { WeekSection } from "./gcal-shared"
import { PILL, splitByWeek } from "./gcal-util"
import { PeopleTimeline } from "./people-timeline"
import {
  useGcalPeople,
  usePeopleSchedule,
  type Person,
  type PersonSchedule,
} from "./use-gcal"

/**
 * 보고 있는 구성원 목록 저장 키. 저장 버튼은 없다 — 고르는 즉시 반영되고,
 * 탭·창을 닫았다 열어도 마지막으로 보던 사람들이 그대로 남게만 한다.
 */
const PEOPLE_KEY = "myspace.gcalPeople"
/** 한 번에 그리는 검색 결과 수 — 주소록은 수천 명일 수 있다. */
const MAX_RESULTS = 30
/** 동시에 볼 수 있는 인원 상한(사람 수만큼 API 호출이 나간다). */
const MAX_SELECTED = 12

/** 검색어 매칭 — 이름과 이메일 양쪽을 본다. */
function matches(p: Person, q: string): boolean {
  return p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)
}

/** 공개 범위 때문에 반쪽만 보이는 경우를 사람 섹션 위에 한 줄로 알린다. */
function AccessNotice({ schedule }: { schedule: PersonSchedule | undefined }) {
  if (!schedule || schedule.access === "full") return null
  if (schedule.access === "busy") {
    return (
      <p className="flex items-center gap-1.5 px-3 text-[13px] text-muted-foreground">
        <EyeOffIcon className="size-3.5 shrink-0" />
        캘린더 공개 범위가 ‘한가함/바쁨’ 이라 제목 없이 시간만 표시됩니다.
      </p>
    )
  }
  return (
    <p className="rounded-lg bg-ui-warning/15 px-3 py-2 text-[13px] text-ui-warning">
      일정을 볼 수 없습니다 — 이 구성원이 캘린더를 공개하지 않았습니다.
      {schedule.error ? ` (${schedule.error})` : ""}
    </p>
  )
}

/**
 * 전체 일정 — 구성원을 검색해 고르면 그 사람들의 이번주·다음주 일정
 * (회의·휴가·외근 가릴 것 없이 전부)이 바로 아래에 나온다.
 *
 * 선택 = 즉시 반영이라 저장 버튼이 없다. 검색 결과는 입력창 아래로 띄우는 드롭다운이라
 * 사람을 추가해도 이미 보고 있던 일정이 밀려 내려가지 않고, 검색어가 남아 있어
 * 같은 검색에서 여러 명을 연달아 고를 수 있다.
 */
export function PeopleView() {
  const [people, setPeople] = useLocalStorage<Person[]>(PEOPLE_KEY, [])
  const [query, setQuery] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const {
    people: directory,
    loading: dirLoading,
    error: dirError,
    load,
  } = useGcalPeople()
  const { byPerson, loading, error, updatedAt, refresh } =
    usePeopleSchedule(people)

  // 검색은 로컬에서 하므로 주소록을 처음 한 번 받아 둔다(Rust 가 7일 캐시를 들고 있다).
  useEffect(() => {
    void load()
  }, [load])

  const q = query.trim().toLowerCase()
  // 주소록 전체를 매 글자마다 훑으므로 검색어가 바뀔 때만 다시 계산한다.
  const hits = useMemo(
    () => (q ? (directory ?? []).filter((p) => matches(p, q)) : []),
    [directory, q]
  )
  const shown = hits.slice(0, MAX_RESULTS)
  const full = people.length >= MAX_SELECTED

  function toggle(p: Person) {
    setPeople((prev) => {
      if (prev.some((x) => x.email === p.email))
        return prev.filter((x) => x.email !== p.email)
      return prev.length >= MAX_SELECTED ? prev : [...prev, p]
    })
    // 검색어는 그대로 둔다 — 같은 검색 결과에서 여러 명을 이어서 고를 수 있게.
    inputRef.current?.focus()
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <UsersIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-[15px] font-bold">구성원 일정</span>
        <span className="text-[13px] text-muted-foreground">
          {people.length}명
          {updatedAt &&
            ` · ${new Date(updatedAt).toLocaleTimeString("ko-KR", {
              hour: "2-digit",
              minute: "2-digit",
            })} 업데이트`}
        </span>
        <Button
          variant="outline"
          className={cn(PILL, "ml-auto")}
          onClick={() => void refresh()}
          disabled={loading || people.length === 0}
        >
          <RefreshCwIcon
            className={cn("size-3.5", loading && "animate-spin")}
          />
          새로고침
        </Button>
      </div>

      {/* 검색 + 선택된 사람 — 항상 화면에 떠 있다. */}
      <div className="flex flex-col gap-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            className="pl-9"
            placeholder="이름 또는 이메일로 구성원 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("")
            }}
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("")
                inputRef.current?.focus()
              }}
              aria-label="검색어 지우기"
              className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-ui-list-hover"
            >
              <XIcon className="size-3.5" />
            </button>
          )}

          {/* 검색 결과 — 아래 일정이 밀리지 않도록 떠 있는 드롭다운. */}
          {q && (
            <div className="absolute inset-x-0 top-full z-20 mt-1 flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-[10px] border border-border bg-card p-2 shadow-[0_4px_16px_rgba(0,0,0,0.16)]">
              {dirLoading && !directory ? (
                <p className="px-3 py-2 text-[13px] text-muted-foreground">
                  주소록을 불러오는 중…
                </p>
              ) : shown.length === 0 ? (
                <p className="px-3 py-2 text-[13px] text-muted-foreground">
                  검색 결과가 없습니다.
                </p>
              ) : (
                shown.map((p) => {
                  const on = people.some((x) => x.email === p.email)
                  return (
                    <button
                      key={p.email}
                      type="button"
                      onClick={() => toggle(p)}
                      // 상한에 걸렸을 때도 이미 고른 사람은 해제할 수 있어야 한다.
                      disabled={full && !on}
                      className={cn(
                        "flex min-h-9 items-center gap-3 rounded-lg px-3 py-1.5 text-left text-[15px] transition-colors hover:bg-ui-list-hover disabled:opacity-40 disabled:hover:bg-transparent",
                        on && "bg-ui-selection/10"
                      )}
                    >
                      <span
                        className={cn(
                          "flex size-5 shrink-0 items-center justify-center rounded-md border",
                          on
                            ? "border-ui-selection bg-ui-selection text-ui-selection-fg"
                            : "border-border"
                        )}
                      >
                        {on && <CheckIcon className="size-3.5" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-semibold">
                        {p.name}
                      </span>
                      <span className="min-w-0 shrink truncate text-[13px] text-muted-foreground">
                        {p.email}
                      </span>
                    </button>
                  )
                })
              )}
              {hits.length > shown.length && (
                <p className="px-3 py-2 text-[13px] text-muted-foreground">
                  {hits.length - shown.length}명 더 있습니다 — 검색어를 좁혀
                  주세요.
                </p>
              )}
            </div>
          )}
        </div>

        {people.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {people.map((p) => (
              <button
                key={p.email}
                type="button"
                onClick={() => toggle(p)}
                title={`${p.email} · 클릭하면 제외`}
                className="flex items-center gap-1 rounded-full bg-ui-selection/15 py-0.5 pr-1.5 pl-2.5 text-[13px] font-semibold text-ui-selection transition-colors hover:bg-ui-selection/25"
              >
                {p.name}
                <XIcon className="size-3.5" />
              </button>
            ))}
            {full && (
              <span className="text-[13px] text-muted-foreground">
                최대 {MAX_SELECTED}명까지 함께 볼 수 있습니다.
              </span>
            )}
          </div>
        )}

        {dirError && (
          <p className="rounded-lg bg-ui-error/15 px-3 py-2 text-[13px] text-ui-error">
            {friendlyError(dirError)}
          </p>
        )}
      </div>

      {error && (
        <p className="rounded-lg bg-ui-error/15 px-3 py-2 text-[15px] text-ui-error">
          {friendlyError(error)}
        </p>
      )}

      {people.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
          <UsersIcon className="size-9 text-muted-foreground" />
          <p className="text-[15px] font-bold">
            보고 싶은 구성원을 검색하세요.
          </p>
          <p className="text-[13px] text-muted-foreground">
            이름을 입력해 고르면 바로 아래에 그 사람의 회의·휴가·외근 일정이
            나옵니다. 여러 명을 골라 함께 볼 수 있습니다.
          </p>
        </div>
      ) : (
        <>
          <PeopleTimeline people={people} byPerson={byPerson} />

          <div className="flex flex-col gap-5">
            {people.map((person) => {
              const schedule = byPerson[person.email]
              const { thisWeek, nextWeek } = splitByWeek(schedule?.events ?? [])
              return (
                <div key={person.email} className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <UsersIcon className="size-4 shrink-0 self-center text-muted-foreground" />
                    <span className="text-[15px] font-bold">{person.name}</span>
                    <span className="text-[13px] text-muted-foreground">
                      {person.email}
                    </span>
                  </div>
                  <AccessNotice schedule={schedule} />
                  {schedule?.access !== "denied" && (
                    <div className="flex flex-col gap-3 pl-1">
                      <WeekSection title="이번주" events={thisWeek} />
                      <WeekSection title="다음주" events={nextWeek} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
