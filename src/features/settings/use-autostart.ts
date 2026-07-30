import { useCallback, useEffect, useState } from "react"
import {
  disable as disableAutoStart,
  enable as enableAutoStart,
  isEnabled as isAutoStartEnabled,
} from "@tauri-apps/plugin-autostart"

import { isTauri } from "@/lib/tauri"
import { useSettings } from "./settings-context"

/*
 * 로그인 시 자동 실행: 설정값(의도)과 OS 등록 상태(macOS 는 ~/Library/LaunchAgents 플리스트)를
 * 맞춘다. 설정값이 원본이고 OS 는 그 사본이다 — 앱 시작 시와 토글 시에만 맞추므로, 사용자가
 * 시스템 설정에서 로그인 항목을 지우면 다음 실행에서 다시 등록된다(대부분의 앱과 같은 동작).
 *
 * 기본값이 켜짐이라 첫 실행에서 바로 등록된다.
 */

/**
 * 개발 실행(bun run tauri dev)에서는 등록하지 않는다 — 등록될 실행 파일이
 * `src-tauri/target/debug/...` 라서, 빌드 폴더를 지우면 깨진 로그인 항목만 남는다.
 * 설정 화면은 이 값이 false 면 그 사실을 문구로 알려 준다.
 */
export const AUTOSTART_SUPPORTED = isTauri() && !import.meta.env.DEV

/** 원하는 상태를 OS 에 반영한다. 이미 그 상태면 아무것도 하지 않는다(몇 번 불러도 같다). */
export async function applyAutoStart(want: boolean): Promise<void> {
  if (!AUTOSTART_SUPPORTED) return
  try {
    if ((await isAutoStartEnabled()) === want) return
    if (want) await enableAutoStart()
    else await disableAutoStart()
  } catch (e) {
    console.error("로그인 시 자동 실행 등록을 바꾸지 못했습니다", e)
  }
}

/**
 * 설정의 `general.autoStart` 를 OS 등록 상태에 반영한다 — 앱 시작 시 한 번, 그리고 값이
 * 바뀔 때마다. 메인 창에서만 마운트한다(App.tsx): 여러 창이 같은 등록을 건드릴 이유가 없다.
 */
export function useAutoStartSync() {
  const want = useSettings().settings.general.autoStart

  useEffect(() => {
    void applyAutoStart(want)
  }, [want])
}

/**
 * 지금 OS 에 실제로 등록돼 있는지. 설정 화면에서 "설정은 켜져 있는데 등록은 안 됐다" 같은
 * 어긋남을 보여 주기 위한 것이다(등록은 조용히 실패할 수 있다).
 * 값이 아직 확인되지 않았거나 확인할 수 없으면 `null`.
 */
export function useAutoStartState(): {
  registered: boolean | null
  refresh: () => void
} {
  const [registered, setRegistered] = useState<boolean | null>(null)

  const refresh = useCallback(() => {
    if (!AUTOSTART_SUPPORTED) return
    void isAutoStartEnabled()
      .then(setRegistered)
      .catch(() => setRegistered(null))
  }, [])

  useEffect(refresh, [refresh])

  return { registered, refresh }
}
