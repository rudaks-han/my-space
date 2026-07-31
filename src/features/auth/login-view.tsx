import { useState, type FormEvent } from "react"
import { CheckIcon, LoaderCircleIcon, LockIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useAuth } from "@/features/auth/auth-context"
import { ldapLogin } from "@/features/auth/ldap"

/**
 * 로그인 폼. 로그인 안 된 상태에서 셸 대신 이 화면이 뜬다.
 *
 * 사내 LDAP 으로 최초 1회 인증하고, "자동 로그인"을 켜 두면 다음 실행부터는 LDAP 요청
 * 없이 바로 들어온다(AuthProvider 가 localStorage 로 관리). 크롬 색 배경 위에 흰 카드를
 * 얹은 Slack 로그인 톤이다.
 */
export function LoginView() {
  const { login, lastUsername } = useAuth()
  const [username, setUsername] = useState(lastUsername)
  const [password, setPassword] = useState("")
  const [autoLogin, setAutoLogin] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (submitting) return
    setError(null)
    setSubmitting(true)
    try {
      const user = await ldapLogin(username, password)
      login(user, autoLogin)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-ui-chrome">
      {/* 오버레이 타이틀바(신호등) 자리 겸 창 드래그 핸들 */}
      <div data-tauri-drag-region className="h-(--ui-titlebar-h) shrink-0" />
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="w-full max-w-[360px] rounded-[10px] bg-background p-6 shadow-[0_4px_16px_rgba(0,0,0,0.16)]">
          {/* 머리말 */}
          <div className="flex flex-col items-center gap-2 text-center">
            <span className="flex size-11 items-center justify-center rounded-[10px] bg-ui-chrome text-ui-chrome-fg">
              <LockIcon className="size-5" />
            </span>
            <h1 className="text-[18px] font-bold tracking-[-0.01em]">
              My Space 로그인
            </h1>
            <p className="text-[13px] text-muted-foreground">
              사내 계정(LDAP)으로 로그인하세요.
            </p>
          </div>

          <form onSubmit={onSubmit} className="mt-5 flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="login-username"
                className="text-[13px] font-semibold"
              >
                아이디
              </label>
              <Input
                id="login-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                autoComplete="username"
                spellCheck={false}
                disabled={submitting}
                placeholder="사내 계정 아이디"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="login-password"
                className="text-[13px] font-semibold"
              >
                비밀번호
              </label>
              <Input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                disabled={submitting}
                placeholder="비밀번호"
              />
            </div>

            {/* 자동 로그인 — 설정 화면과 같은 라운드 사각 체크박스 */}
            <button
              type="button"
              role="switch"
              aria-checked={autoLogin}
              onClick={() => setAutoLogin((v) => !v)}
              disabled={submitting}
              className="mt-0.5 flex cursor-pointer items-center gap-2 self-start text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid"
            >
              <span
                className={cn(
                  "flex size-[18px] shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                  autoLogin
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input bg-background"
                )}
              >
                {autoLogin && <CheckIcon className="size-3.5" />}
              </span>
              <span className="text-[13px]">
                자동 로그인 (다음부터 자동으로 로그인)
              </span>
            </button>

            {error && (
              <div className="rounded-lg bg-ui-error/10 px-3 py-2 text-[13px] text-ui-error">
                {error}
              </div>
            )}

            <Button
              type="submit"
              disabled={submitting}
              className="mt-1 h-10 w-full text-[15px] font-bold"
            >
              {submitting && (
                <LoaderCircleIcon className="size-4 animate-spin" />
              )}
              {submitting ? "로그인 중…" : "로그인"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
