/**
 * 이 앱이 돌고 있는 OS. `menus.tsx` 의 `unsupported` 가 이 값으로 갈린다.
 *
 * **웹뷰의 userAgent 로 판별한다 — Rust 커맨드가 아니다.** 지원하지 않는 메뉴는
 * *첫 렌더부터* 뷰가 아예 마운트되지 않아야 하는데(세션 목록·IntelliJ 서비스는 마운트
 * 즉시 폴링을 시작한다), `invoke` 는 비동기라 한 프레임을 흘리거나 앱 시작을 붙잡아야 한다.
 * UA 는 OS 의 웹뷰 엔진이 직접 박아 넣는 값이고(WebView2 → `Windows NT`,
 * WKWebView → `Macintosh`) 이 앱은 창을 만들 때 user agent 를 덮어쓰지 않으므로
 * 이 목적에는 충분하면서 동기다.
 *
 * 버전·아키텍처처럼 더 정확한 OS 정보가 필요해지면 `@tauri-apps/plugin-os` 로 올린다.
 */
export type Platform = "macos" | "windows" | "linux"

function detect(): Platform {
  const ua = navigator.userAgent
  if (ua.includes("Windows")) return "windows"
  if (ua.includes("Macintosh") || ua.includes("Mac OS X")) return "macos"
  return "linux"
}

export const PLATFORM: Platform = detect()
