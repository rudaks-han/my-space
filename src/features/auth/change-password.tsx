import { useCallback, useEffect, useState } from "react"
import { CheckIcon, KeyRoundIcon, RotateCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

import type { AuthUser } from "./auth-context"
import {
  changeLdapPassword,
  fetchPasswordPolicy,
  type PasswordPolicy,
} from "./ldap"

/*
 * 설정 → 계정의 비밀번호 변경 폼.
 *
 * 사내 정책상 한 달마다 비밀번호를 바꿔야 하는데, 맥에는 Windows 의 Ctrl+Alt+Del 같은
 * 변경 창이 없어 매번 번거로운 절차를 거쳐야 한다. 이 폼은 그 절차를 대신한다 —
 * Rust 의 `ldap_change_password` 가 AD 에 LDAPS 로 붙어 본인 확인 후 unicodePwd 를 바꾼다.
 *
 * 이 화면이 지키는 규칙 세 가지:
 *  - **규칙과 만료일은 하드코딩하지 않고 AD 에서 읽어 온다**(`ldap_password_policy`).
 *    관리자가 정책을 바꾸면 화면이 조용히 거짓말을 하게 되기 때문이다.
 *  - **클라이언트 검사는 경고까지만이고 차단은 최소한이다.** 길이·재입력 일치처럼 확실한
 *    것만 버튼을 막고, 복잡도·계정명 포함 같은 판정은 노란 경고로만 알린 뒤 전송을
 *    허용한다 — 최종 판정자는 AD 이고, 여기서 오탐이 나면 바꿀 수 있는 비밀번호를
 *    바꾸지 못하게 된다.
 *  - **현재 비밀번호를 틀리면 잠금 카운터가 올라간다**(도메인 정책상 5회). 그래서 실패
 *    메시지에 그 사실을 함께 알린다.
 */

/** Slack 흰 패널 — 10px 라운드 + 아주 옅은 그림자. */
const PANEL =
  "flex flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]"

/** 패널 헤더 — 굵은 15px 제목 + 아래 구분선. */
const PANEL_HEADER =
  "flex shrink-0 items-center gap-2 border-b border-border px-4 py-3 text-[15px] font-semibold"

/** 만료가 이 일수 이내로 남으면 경고색으로 알린다. */
const EXPIRY_WARN_DAYS = 7

const MS_PER_DAY = 86_400_000

/**
 * AD 복잡도 규칙이 세는 문자 종류 — 대문자·소문자·숫자·기호·비ASCII 문자의 5범주 중
 * 3가지 이상이어야 한다. 기호와 비ASCII 를 하나로 합치면 실제보다 적게 세어("한글!abc"
 * 는 AD 기준 3범주다) 통과할 비밀번호를 경고하게 되므로 나눠 센다.
 */
function complexityKinds(pw: string): number {
  const tests: ((s: string) => boolean)[] = [
    (s) => /[A-Z]/.test(s),
    (s) => /[a-z]/.test(s),
    (s) => /[0-9]/.test(s),
    (s) => /[!-/:-@[-`{-~]/.test(s),
    // 비ASCII(한글 등)는 코드포인트로 본다 — 정규식으로 쓰면 제어문자 범위를 적게 된다.
    (s) => [...s].some((c) => (c.codePointAt(0) ?? 0) > 127),
  ]
  return tests.filter((t) => t(pw)).length
}

/**
 * AD 는 계정명(3자 이상)이나 표시 이름의 토큰(3자 이상)이 비밀번호에 들어 있으면
 * 대소문자를 무시하고 거부한다.
 */
function containsUserName(pw: string, user: AuthUser): boolean {
  const lower = pw.toLowerCase()
  const account = user.username.trim().toLowerCase()
  if (account.length >= 3 && lower.includes(account)) return true
  return user.displayName
    .split(/[\s,.\-_#\t]+/)
    .some((tok) => tok.length >= 3 && lower.includes(tok.toLowerCase()))
}

/** epoch ms 를 "2026년 9월 2일" 로. */
function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
  })
}

/** 남은 기간을 "26일 남음" / "3시간 남음" / "지났습니다" 로. */
function formatRemaining(ms: number): string {
  if (ms <= 0) return "기한이 지났습니다"
  const days = Math.floor(ms / MS_PER_DAY)
  if (days >= 1) return `${days}일 남음`
  const hours = Math.max(1, Math.round(ms / 3_600_000))
  return `${hours}시간 남음`
}

/** 정책을 사람이 읽는 규칙 목록으로. AD 에서 읽은 값만 쓴다. */
function ruleLines(policy: PasswordPolicy): string[] {
  const lines: string[] = []
  if (policy.minLength > 0) lines.push(`${policy.minLength}자 이상`)
  if (policy.complexity) {
    lines.push(
      "영문 대문자·소문자·숫자·기호 중 3가지 이상 포함 (이름·아이디는 포함 불가)"
    )
  }
  if (policy.historyLength > 0) {
    lines.push(`최근 ${policy.historyLength}개는 다시 쓸 수 없음`)
  }
  if (policy.minAgeDays) {
    lines.push(`마지막 변경 후 ${policy.minAgeDays}일이 지나야 다시 변경 가능`)
  }
  if (policy.maxAgeDays) lines.push(`${policy.maxAgeDays}일마다 만료`)
  return lines
}

/** 만료일 안내 줄 — 정책을 읽었을 때만 나온다. */
function ExpiryNotice({
  policy,
  now,
}: {
  policy: PasswordPolicy
  now: number
}) {
  if (policy.neverExpires) {
    return (
      <p className="text-[13px] text-muted-foreground">
        이 계정은 비밀번호 만료가 적용되지 않습니다.
      </p>
    )
  }
  if (policy.lastSetAt === null) {
    return (
      <p className="text-[13px] text-ui-warning">
        다음 로그온 시 비밀번호를 반드시 변경해야 하는 상태입니다.
      </p>
    )
  }
  if (policy.expiresAt === null) return null

  const left = policy.expiresAt - now
  const urgent = left <= EXPIRY_WARN_DAYS * MS_PER_DAY
  return (
    <p
      className={cn(
        "text-[13px]",
        urgent ? "font-semibold text-ui-warning" : "text-muted-foreground"
      )}
    >
      만료 예정: {formatDate(policy.expiresAt)} ({formatRemaining(left)})
    </p>
  )
}

/** 사내 LDAP 비밀번호 변경 폼. */
export function ChangePasswordPanel({ user }: { user: AuthUser }) {
  const [policy, setPolicy] = useState<PasswordPolicy | null>(null)
  const [policyError, setPolicyError] = useState<string | null>(null)
  /** 정책을 읽은 시각 — 남은 기간 계산의 기준. 렌더 중 Date.now() 를 부르지 않기 위한 값. */
  const [loadedAt, setLoadedAt] = useState(0)

  /**
   * 폼을 펼쳤는지. 기본은 접힌 상태다 — 만료일을 확인하러 계정 화면을 여는 일이
   * 실제로 바꾸는 일보다 훨씬 잦은데, 비밀번호 입력칸이 늘 떠 있으면 그때마다
   * 입력을 요구받는 것처럼 보인다.
   */
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  // 첫 setState 가 await 뒤에 오는 것이 중요하다 — 마운트 effect 에서 부르므로,
  // 동기적으로 상태를 바꾸면 cascading render 가 된다(react-hooks/set-state-in-effect).
  const loadPolicy = useCallback(async () => {
    try {
      const p = await fetchPasswordPolicy(user.username)
      setPolicy(p)
      setPolicyError(null)
      setLoadedAt(Date.now())
    } catch (e) {
      setPolicyError(e instanceof Error ? e.message : String(e))
    }
  }, [user.username])

  // 마운트할 때 한 번 정책을 읽는다.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPolicy()
  }, [loadPolicy])

  // ── 검사 — 확실한 것만 버튼을 막고(hard), 나머지는 경고만(soft) ──
  const tooShort = next.length > 0 && next.length < (policy?.minLength ?? 0)
  const mismatch = confirm.length > 0 && next !== confirm
  const sameAsCurrent = next.length > 0 && next === current
  const filled = Boolean(current && next && confirm)
  const canSubmit = filled && !tooShort && !mismatch && !sameAsCurrent && !busy

  const warnComplexity =
    next.length > 0 &&
    (policy?.complexity ?? false) &&
    complexityKinds(next) < 3
  const warnUserName = next.length > 0 && containsUserName(next, user)
  const tooSoon =
    policy?.minAgeDays != null &&
    policy.lastSetAt != null &&
    loadedAt > 0 &&
    policy.lastSetAt + policy.minAgeDays * MS_PER_DAY > loadedAt

  /** 입력한 비밀번호를 화면 상태에 남겨 두지 않는다. */
  function clearFields() {
    setCurrent("")
    setNext("")
    setConfirm("")
    setError(null)
  }

  async function handleSubmit() {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      await changeLdapPassword(user.username, current, next)
      // 성공하면 폼을 접고 결과만 남긴다 — 방금 바꾼 칸이 그대로 떠 있으면
      // 변경이 됐는지 안 됐는지 읽히지 않는다.
      setDone(true)
      setOpen(false)
      clearFields()
      // 만료일이 오늘 기준으로 새로 계산되도록 정책을 다시 읽는다.
      void loadPolicy()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 입력이 바뀌면 이전 결과 표시를 치운다 — 낡은 성공/실패가 남아 있으면 오해를 부른다. */
  function edit(set: (v: string) => void) {
    return (v: string) => {
      set(v)
      if (done) setDone(false)
      if (error) setError(null)
    }
  }

  return (
    <div className={PANEL}>
      <div className={PANEL_HEADER}>
        <KeyRoundIcon className="size-4" />
        비밀번호 변경
      </div>

      <div className="flex flex-col gap-4 p-4">
        {/* 만료 정보는 폼을 펼쳤든 접었든 항상 보인다 — 이 화면을 여는 가장 잦은 이유다. */}
        <div className="flex flex-col gap-1">
          <p className="text-[13px] text-muted-foreground">
            사내 계정(Active Directory)의 비밀번호를 여기서 바로 바꿉니다.
            로그아웃하거나 다시 로그인할 필요는 없습니다.
          </p>
          {policy ? (
            <ExpiryNotice policy={policy} now={loadedAt} />
          ) : policyError ? (
            <p className="text-[13px] text-ui-error">
              정책을 읽지 못했습니다: {policyError}
            </p>
          ) : (
            <p className="text-[13px] text-muted-foreground">정책을 읽는 중…</p>
          )}
        </div>

        {/* 접힌 상태 — 결과 표시와 "비밀번호 변경" 버튼만. */}
        {!open ? (
          <>
            {done ? (
              <p className="flex items-center gap-1.5 rounded-lg bg-ui-success/10 px-3 py-2 text-[13px] font-semibold text-ui-success">
                <CheckIcon className="size-3.5" />
                비밀번호를 변경했습니다. 다른 기기·서비스에서도 새 비밀번호를
                사용하세요.
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <Button
                className="rounded-full"
                onClick={() => {
                  setDone(false)
                  clearFields()
                  setOpen(true)
                }}
              >
                <KeyRoundIcon className="size-3.5" />
                비밀번호 변경
              </Button>
              <Button
                variant="ghost"
                className="rounded-full text-[13px]"
                onClick={() => void loadPolicy()}
              >
                <RotateCwIcon className="size-3.5" />
                만료 정보 새로고침
              </Button>
            </div>
          </>
        ) : (
          <>
            {tooSoon && policy?.minAgeDays ? (
              <p className="rounded-lg bg-ui-warning/10 px-3 py-2 text-[13px] text-ui-warning">
                마지막 변경 후 {policy.minAgeDays}일이 지나지 않아 서버가 변경을
                거부할 수 있습니다.
              </p>
            ) : null}

            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pw-current" className="text-[13px]">
                  현재 비밀번호
                </Label>
                <Input
                  id="pw-current"
                  type="password"
                  autoComplete="current-password"
                  // 버튼을 눌러 연 폼이니 바로 타이핑할 수 있게 한다.
                  autoFocus
                  value={current}
                  onChange={(e) => edit(setCurrent)(e.target.value)}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pw-new" className="text-[13px]">
                  새 비밀번호
                </Label>
                <Input
                  id="pw-new"
                  type="password"
                  autoComplete="new-password"
                  value={next}
                  onChange={(e) => edit(setNext)(e.target.value)}
                />
                {tooShort ? (
                  <p className="text-[13px] text-ui-error">
                    {policy?.minLength}자 이상이어야 합니다.
                  </p>
                ) : sameAsCurrent ? (
                  <p className="text-[13px] text-ui-error">
                    현재 비밀번호와 같습니다.
                  </p>
                ) : warnUserName ? (
                  <p className="text-[13px] text-ui-warning">
                    이름이나 아이디가 들어 있으면 거부될 수 있습니다.
                  </p>
                ) : warnComplexity ? (
                  <p className="text-[13px] text-ui-warning">
                    영문 대문자·소문자·숫자·기호 중 3가지 이상을 섞는 것이
                    좋습니다.
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pw-confirm" className="text-[13px]">
                  새 비밀번호 확인
                </Label>
                <Input
                  id="pw-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => edit(setConfirm)(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSubmit()
                  }}
                />
                {mismatch ? (
                  <p className="text-[13px] text-ui-error">
                    새 비밀번호가 서로 다릅니다.
                  </p>
                ) : null}
              </div>
            </div>

            {policy && ruleLines(policy).length > 0 ? (
              <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-muted-foreground">
                {ruleLines(policy).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}

            {error ? (
              <p className="rounded-lg bg-ui-error/10 px-3 py-2 text-[13px] text-ui-error">
                {error}
              </p>
            ) : null}

            <div className="flex items-center gap-2">
              <Button
                className="rounded-full"
                disabled={!canSubmit}
                onClick={() => void handleSubmit()}
              >
                {busy ? "변경 중…" : "변경하기"}
              </Button>
              <Button
                variant="ghost"
                className="rounded-full text-[13px]"
                disabled={busy}
                onClick={() => {
                  clearFields()
                  setOpen(false)
                }}
              >
                취소
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
