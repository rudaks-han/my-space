/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useMemo, type ReactNode } from "react"
import { MoonIcon, SunIcon } from "lucide-react"

import { useIsDark } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useLocalStorage } from "@/lib/use-local-storage"
import { cn } from "@/lib/utils"
import { NS } from "./types"

const STORAGE_KEY = `${NS}.dark`

export interface DevDark {
  /** 지금 이 화면을 다크로 그려야 하는지(= 앱이 다크거나, 이 화면만 다크). */
  dark: boolean
  /** 앱 전체가 다크인지. 그러면 이 화면만 라이트로 만들 수는 없다(뷰 머리말 참고). */
  appDark: boolean
  /** 이 화면만 다크로 보라는 사용자 선택. */
  devDark: boolean
  toggle: () => void
}

const DevDarkContext = createContext<DevDark | null>(null)

function useDevDarkValue(): DevDark {
  const appDark = useIsDark()
  const [devDark, setDevDark] = useLocalStorage<boolean>(STORAGE_KEY, false)
  return useMemo(
    () => ({
      dark: appDark || devDark,
      appDark,
      devDark,
      toggle: () => setDevDark((v) => !v),
    }),
    [appDark, devDark, setDevDark]
  )
}

/**
 * "IntelliJ Cowork 화면만 다크" 선택을 창 전체에 하나로 공급한다.
 *
 * 컨텍스트여야 하는 이유는 **토글이 뷰 밖에 있기 때문**이다 — 버튼은 셸의 뷰 헤더
 * (제목 "IntelliJ Cowork" 옆)에 있고 `dark` 클래스를 실제로 붙이는 곳은 뷰의 뿌리 카드라,
 * 두 컴포넌트가 같은 값을 봐야 한다. 같은 창 안에서 `useLocalStorage` 를 두 번 부르면
 * 서로의 쓰기를 통보받지 못하므로(`storage` 이벤트는 **다른 창**에서만 온다) 버튼을
 * 눌러도 화면이 바뀌지 않는다 — 레일 고정 목록·DB 접속 목록이 컨텍스트인 것과 같은
 * 이유다(`db-connections-store.tsx` 주석 참고).
 */
export function DevDarkProvider({ children }: { children: ReactNode }) {
  const value = useDevDarkValue()
  return (
    <DevDarkContext.Provider value={value}>{children}</DevDarkContext.Provider>
  )
}

/** 프로바이더가 없으면 자기 몫으로 물러난다(화면은 최소한 제 색을 낸다). */
export function useDevDark(): DevDark {
  const ctx = useContext(DevDarkContext)
  const fallback = useDevDarkValue()
  return ctx ?? fallback
}

/**
 * 뷰 헤더(제목 옆)의 다크 모드 토글 — 메인 창의 탭 바와 팝아웃 창이 같은 것을 쓴다.
 *
 * 앱이 이미 다크면 누를 것이 없으므로 비활성이지만 **켜진 상태로** 보여 준다: 눌러도
 * 밝아지지 않는데 꺼진 것처럼 보이면 고장으로 읽힌다.
 */
export function DevDarkToggle() {
  const { dark, appDark, devDark, toggle } = useDevDark()
  const label = appDark
    ? "앱 전체가 다크 모드입니다 — 이 화면도 그대로 따릅니다"
    : devDark
      ? "이 화면만 다크 모드 — 끄면 앱 테마를 따릅니다"
      : "이 화면만 다크 모드로 봅니다(다른 메뉴는 그대로)"

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn("shrink-0", dark && "bg-ui-list-hover")}
            aria-label={label}
            disabled={appDark}
            onClick={toggle}
          >
            {dark ? <SunIcon className="text-ui-warning" /> : <MoonIcon />}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
