import { useEffect, useRef, useState } from "react"
import { listen } from "@tauri-apps/api/event"

import { isTauri, trackedInvoke } from "@/lib/tauri"
import { isMainWindow } from "@/lib/window-role"
import { useSettings } from "@/features/settings/settings-context"
import { petWindowSize } from "./pet-metrics"
import { readPetAnchor } from "./pet-anchor"
import { petArt } from "./pet-sprite"

/**
 * 펫 창을 띄우거나 숨기는 무표시 컴포넌트(App.tsx 에 한 번 마운트).
 *
 * 표시 조건은 **두 축의 OR** 이다:
 *  - `settings.pet.enabled` — 사용자가 켜 둔 "상시 표시".
 *  - Rust 의 `pet:alert` — 리마인더·Claude Code 알림이 대기 중(pet.rs 의 PetAlert).
 *
 * 두 번째 축이 필요한 이유: 트레이 팝오버 창을 없앤 뒤로 펫이 유일한 알림 창구인데,
 * 상시 표시는 기본이 꺼짐이다. 꺼져 있다고 알림을 삼키면 안 되므로 알릴 것이 있는 동안만
 * 잠깐 나타나고 정리되면 다시 숨는다. 판단을 Rust 가 하는 이유도 같다 — 숨은 창의 웹뷰는
 * 로드되지 않아 펫 창 스스로는 "알릴 게 생겼다"를 알아챌 수 없다.
 *
 * 창 제어는 전역 동작이라 **메인 창에서만** 돈다 — 팝아웃 창(`view-*`)까지 pet_show 를
 * 부르면 두 창이 번갈아 위치를 되돌린다(reminder-store 등이 isMainWindow 로 막는 것과 같은 이유).
 *
 * 넘기는 크기는 `petWindowSize()` — 캐릭터 + 여백까지 포함한 **실제 창 크기**여야 한다.
 * 캐릭터 크기만 넘기면 첫 표시에서 창이 여백만큼 짧아 캐릭터 위쪽이 잘린다.
 * 말풍선이 붙어 더 커지는 건 펫 창이 내용을 재서 스스로 pet_resize 한다(pet-root.tsx).
 */
export function PetController() {
  const { settings, setPet } = useSettings()
  const { enabled, scale } = settings.pet
  const noticeSeconds = settings.pet.noticeSeconds ?? 12
  // 세로비는 그리는 쪽과 **같은 판단**에서 가져온다 — 스프라이트 프레임은 세로로 길고
  // (192×208) 이미지 종류는 정사각이라, 여기서 따로 계산하면 첫 표시에서 위가 잘린다.
  const aspect = petArt(settings.pet).aspect

  /** 알림 때문에 임시로 띄워야 하는지(Rust 가 알려 준다). */
  const [alert, setAlert] = useState(false)

  useEffect(() => {
    if (!isTauri() || !isMainWindow) return
    // 마운트 시 한 번 조회 — 앱이 막 떠서 이벤트를 놓쳤을 수 있다.
    void trackedInvoke<boolean>("pet_alert").then(setAlert)
    const unlisten = listen<boolean>("pet:alert", (e) => setAlert(e.payload))
    return () => void unlisten.then((f) => f())
  }, [])

  /*
   * 트레이 메뉴의 "펫 표시/숨기기". 설정이 localStorage 에 있어 Rust 가 직접 뒤집을 수
   * 없으므로 요청만 받아 여기서 처리한다 — 설정을 바꾸면 아래 effect 가 창을 따라 움직인다.
   *
   * 현재 값은 ref 로 읽는다. 의존성에 넣으면 토글마다 리스너를 떼고 다시 붙이는데,
   * 그 틈에 들어온 클릭이 사라진다.
   */
  const enabledRef = useRef(enabled)
  useEffect(() => {
    enabledRef.current = enabled
  }, [enabled])
  useEffect(() => {
    if (!isTauri() || !isMainWindow) return
    const unlisten = listen("pet:toggle", () => {
      setPet({ enabled: !enabledRef.current })
    })
    return () => void unlisten.then((f) => f())
  }, [setPet])

  /*
   * 알림 표시 시간을 Rust 에도 알려 준다. 상시 표시를 꺼 두면 펫이 떠 있는 시간은
   * herdr 감시 루프(`present_until`)가 정하므로, 말풍선 쪽만 바꾸면 같은 알림이
   * 7초/12초로 다르게 보인다(실제로 그렇게 어긋나 있었다). 펫을 꺼 뒀을 때도 알림으로
   * 잠깐 뜨는 경로가 있으니 enabled 와 무관하게 항상 맞춰 둔다.
   */
  useEffect(() => {
    if (!isTauri() || !isMainWindow) return
    void trackedInvoke("pet_set_notice_ttl", { seconds: noticeSeconds })
  }, [noticeSeconds])

  useEffect(() => {
    if (!isTauri() || !isMainWindow) return
    if (!enabled && !alert) {
      void trackedInvoke("pet_hide")
      return
    }
    // 저장된 자리는 여기서 매번 새로 읽는다 — 펫이 스스로 저장하므로 상태로 들고 있으면
    // 드래그마다 이 effect 가 다시 돌아 창이 초기 크기로 되돌아간다.
    const anchor = readPetAnchor()
    const { width, height } = petWindowSize(scale, aspect)
    void trackedInvoke("pet_show", {
      width,
      height,
      centerX: anchor?.centerX ?? null,
      bottom: anchor?.bottom ?? null,
    })
  }, [enabled, alert, scale, aspect])

  return null
}
