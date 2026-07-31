/**
 * Flex(휴가) 설정 패널 — 로그인 계정 등록.
 *
 * Flex 는 공개 API 가 없어 웹 세션으로 API 를 호출한다. 세션은
 *  1) 앱이 자동 로그인해서 받은 토큰 → 2) Chrome 에 로그인된 세션
 * 순으로 찾고, 둘 다 없으면 여기 저장한 계정으로 자동 로그인한다(브라우저 창 없이
 * 로그인 화면이 쓰는 API 를 그대로 호출한다 — 자세한 흐름은 `src-tauri/src/flex.rs`).
 */
import { LogOutIcon, RefreshCwIcon, UsersIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select"
import { trackedInvoke } from "@/lib/tauri"
import { cn } from "@/lib/utils"

import { useFlexCoworkers, useFlexMyDept } from "./use-flex"

/** Slack 흰 패널 — 10px 라운드 + 아주 옅은 그림자. */
const PANEL =
  "flex flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]"

const PANEL_HEADER =
  "flex shrink-0 items-center border-b border-border px-4 py-3 text-[15px] font-semibold"

const PILL = "h-7 rounded-full px-3 text-[13px] font-semibold"

/** Rust `FlexStatus` 와 같은 모양. */
interface FlexStatus {
  email: string | null
  canAutoLogin: boolean
  loggedIn: boolean
  source: "app" | "chrome" | null
}

/** 자동 로그인 실패 원인을 한국어로. */
function loginError(code: string): string {
  if (code.includes("no_credentials"))
    return "저장된 계정이 없습니다. 이메일과 비밀번호를 입력해 주세요."
  if (code.includes("empty_credentials"))
    return "이메일과 비밀번호를 모두 입력해 주세요."
  // flex 서버가 준 한국어 메시지("계정 또는 비밀번호에 오류가 있어요." 등)는 그대로 보여 준다.
  if (/[가-힣]/.test(code)) return code
  return `오류: ${code}`
}

/** "자동" 을 뜻하는 값 — Select 는 빈 문자열을 값으로 쓰기 애매해서 별도 토큰을 쓴다. */
const AUTO = "__auto__"

/** 자동 감지도 실패했을 때(로그인 전 등)의 표시. */
const NONE_LABEL = "자동 (아직 못 읽음)"

/**
 * 내 부서 — 같은 부서 구성원을 휴가 목록에서 칩으로 강조하는 기준.
 *
 * 기본은 **자동**이다: `flex_me` 가 구성원 검색으로 내 부서를 읽어 온다(coworkers 목록에는
 * 나 자신이 빠져 있어서 그 경로로는 알 수 없다 — `src-tauri/src/flex.rs` 참고).
 * 직접 고르는 건 자동으로 읽힌 단위가 원하는 단위와 다를 때를 위한 수동 지정이다
 * (예: 내 소속은 "제품개발본부" 인데 팀 단위로 강조하고 싶을 때).
 */
function MyDepartmentPanel() {
  const { coworkers, me, loading, refresh } = useFlexCoworkers()
  const { dept, picked, setPicked } = useFlexMyDept(me)

  // 자동으로 읽힌 부서를 그대로 보여 준다(못 읽었으면 그렇다고 쓴다).
  const autoLabel = me?.department ? `자동 — ${me.department}` : NONE_LABEL

  // 구성원 캐시에 있는 부서들(중복 제거 + 가나다순).
  const departments = useMemo(() => {
    const set = new Set<string>()
    for (const c of coworkers) if (c.department) set.add(c.department)
    return [...set].sort((a, b) => a.localeCompare(b, "ko"))
  }, [coworkers])

  return (
    <div className={PANEL}>
      <div className={PANEL_HEADER}>내 부서</div>
      <div className="flex flex-col gap-3 p-4 text-[15px]">
        <p className="text-[13px] text-muted-foreground">
          {me?.name ? `${me.name} 님과 ` : ""}같은 부서 구성원은 휴가 목록에서
          이름·부서가 칩으로 강조됩니다. 부서는 flex 에서 자동으로 읽어 오며,
          다른 단위로 강조하고 싶을 때만 직접 고르세요.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={picked ?? AUTO}
            onValueChange={(v) => setPicked(v === AUTO ? null : String(v))}
          >
            <SelectTrigger className="min-w-56">
              <span
                className={cn(
                  "flex-1 text-left",
                  picked === null && "text-muted-foreground"
                )}
              >
                {picked ?? autoLabel}
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO}>{autoLabel}</SelectItem>
              {departments.map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            className={PILL}
            onClick={() => void refresh()}
            disabled={loading}
            title="부서 목록을 다시 불러옵니다"
          >
            <UsersIcon className={cn("size-3.5", loading && "animate-spin")} />
            구성원 새로고침
          </Button>

          <span className="text-[13px] text-muted-foreground">
            {dept ? `강조 기준: ${dept}` : "강조 안 함"}
          </span>
        </div>

        {departments.length === 0 && (
          <p className="text-[13px] text-muted-foreground">
            구성원 목록이 비어 있습니다. 로그인 후 "구성원 새로고침"을 눌러
            주세요.
          </p>
        )}
      </div>
    </div>
  )
}

export function FlexSettingsPanel() {
  const [status, setStatus] = useState<FlexStatus | null>(null)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState<null | "check" | "save" | "login">(null)
  const [error, setError] = useState<string | null>(null)

  const check = useCallback(async () => {
    setBusy("check")
    setError(null)
    try {
      const s = await trackedInvoke<FlexStatus>("flex_status")
      setStatus(s)
      setEmail((prev) => prev || (s.email ?? ""))
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }, [])

  // 패널을 열 때 한 번 현재 세션 상태를 확인한다.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void check()
  }, [check])

  async function save() {
    if (busy) return
    setBusy("save")
    setError(null)
    try {
      const s = await trackedInvoke<FlexStatus>("flex_save_account", {
        email: email.trim(),
        password,
      })
      setStatus(s)
      setPassword("")
    } catch (e) {
      setError(String(e))
      // 로그인은 실패해도 계정 자체는 저장됐을 수 있으니 상태를 다시 읽는다.
      void check()
    } finally {
      setBusy(null)
    }
  }

  async function loginNow() {
    if (busy) return
    setBusy("login")
    setError(null)
    try {
      setStatus(await trackedInvoke<FlexStatus>("flex_login_now"))
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  async function clearAccount() {
    if (busy) return
    setError(null)
    try {
      await trackedInvoke("flex_clear_account")
      setPassword("")
      await check()
    } catch (e) {
      setError(String(e))
    }
  }

  const ready = email.trim() !== "" && password !== ""

  return (
    <div className="flex flex-col">
      <div className="border-b border-border pb-3">
        <h2 className="text-[18px] font-bold tracking-[-0.01em]">Flex 휴가</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Flex 는 공개 API 가 없어 웹 로그인 세션으로 휴가·구성원 일정을
          불러옵니다. 계정을 저장해 두면 세션이 없거나 만료됐을 때 앱이 대신
          로그인합니다.
        </p>
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {/* 현재 세션 상태 */}
        <div
          className={cn(
            "rounded-[10px] border px-4 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.06)]",
            status?.loggedIn
              ? "border-ui-success/40 bg-ui-success/15"
              : "border-border bg-card"
          )}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                status?.loggedIn ? "bg-ui-success" : "bg-muted-foreground"
              )}
            />
            <span className="text-[15px] font-bold">
              {status === null
                ? "상태 확인 중…"
                : status.loggedIn
                  ? "세션 있음"
                  : "세션 없음"}
            </span>
            <span className="text-[13px] text-muted-foreground">
              {status?.source === "chrome"
                ? "Chrome 에 로그인된 세션 사용 중"
                : status?.source === "app"
                  ? "앱이 로그인한 세션 사용 중"
                  : status?.canAutoLogin
                    ? "저장된 계정으로 자동 로그인합니다"
                    : "Chrome 로그인 또는 계정 저장이 필요합니다"}
            </span>
            <div className="ml-auto flex gap-2">
              <Button
                variant="outline"
                className={PILL}
                onClick={() => void check()}
                disabled={busy !== null}
              >
                <RefreshCwIcon
                  className={cn("size-3.5", busy === "check" && "animate-spin")}
                />
                상태 확인
              </Button>
              {status?.canAutoLogin && (
                <Button
                  variant="outline"
                  className={PILL}
                  onClick={() => void loginNow()}
                  disabled={busy !== null}
                >
                  {busy === "login" ? "로그인 중…" : "다시 로그인"}
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* 같은 부서 강조 기준 */}
        <MyDepartmentPanel />

        {/* 계정 입력 */}
        <div className={PANEL}>
          <div className={PANEL_HEADER}>
            {status?.canAutoLogin ? "저장된 Flex 계정" : "Flex 계정 저장"}
          </div>
          <div className="flex flex-col gap-3 p-4 text-[15px]">
            <p className="text-[13px] text-muted-foreground">
              flex.team 로그인에 쓰는 이메일과 비밀번호입니다. 비밀번호는 이
              맥에서만 풀 수 있도록 암호화해 앱 설정 폴더에 저장합니다(외부로
              보내지 않습니다).
            </p>

            <div className="flex flex-col gap-2">
              <Label htmlFor="flex-email">이메일</Label>
              <Input
                id="flex-email"
                placeholder="아이디@spectra.co.kr"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void save()
                }}
                className="ui-selectable"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="flex-password">비밀번호</Label>
              <div className="flex gap-2">
                <Input
                  id="flex-password"
                  type="password"
                  placeholder={
                    status?.canAutoLogin
                      ? "저장됨 — 바꾸려면 새로 입력"
                      : "비밀번호"
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void save()
                  }}
                  className="ui-selectable"
                />
                <Button
                  onClick={() => void save()}
                  disabled={busy !== null || !ready}
                >
                  {busy === "save" ? "로그인 중…" : "저장하고 로그인"}
                </Button>
                {status?.canAutoLogin && (
                  <Button
                    variant="ghost"
                    className={PILL}
                    onClick={() => void clearAccount()}
                    disabled={busy !== null}
                  >
                    <LogOutIcon className="size-3.5" />
                    계정 삭제
                  </Button>
                )}
              </div>
            </div>

            {error && (
              <p className="rounded-lg bg-ui-error/15 px-3 py-2 text-[15px] text-ui-error">
                {loginError(error)}
              </p>
            )}
          </div>
        </div>

        <p className="text-[13px] text-muted-foreground">
          계정을 저장하지 않아도, Chrome 에서 flex.team 에 로그인해 두면 그
          세션을 그대로 씁니다(처음 한 번 macOS 키체인 접근 허용 창이 뜰 수
          있습니다).
        </p>
      </div>
    </div>
  )
}
