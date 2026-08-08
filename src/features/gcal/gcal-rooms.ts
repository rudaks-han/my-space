import type { RoomRef } from "./use-gcal"

/**
 * 선택한 회의실 목록 저장 키.
 *
 * 쓰는 쪽은 회의실 뷰(`rooms-view.tsx`) 하나뿐이고, 상단바 예약 팔레트는 **읽기만** 한다 —
 * 같은 창에서 같은 키로 `useLocalStorage` 를 두 번 걸면 서로의 쓰기를 보지 못해(`storage`
 * 이벤트는 다른 창에만 간다) 한쪽이 다른 쪽의 선택을 덮어쓴다.
 */
export const ROOMS_KEY = "myspace.gcalRooms"

/**
 * 자주 쓰는 회의실 표시 이름(추천 선택용). 실제 예약엔 캘린더 ID 가 필요하므로,
 * 이 이름과 내 캘린더 목록의 summary 를 매칭해 회의실을 자동 추천한다.
 */
export const KNOWN_ROOM_NAMES = [
  "spectra-3-북카페(통로측)",
  "spectra-3-북카페-북카페",
  "spectra-3-세미나실",
  "spectra-3-여직원휴게실",
  "spectra-3-창의룸",
]

/** summary 가 알려진 회의실 이름 중 하나와 (느슨하게) 일치하는지. */
export function looksLikeKnownRoom(summary: string): boolean {
  const s = summary.trim()
  return KNOWN_ROOM_NAMES.some((n) => s === n || s.includes(n) || n.includes(s))
}

/**
 * 저장된 회의실을 localStorage 에서 그때그때 직접 읽는다(팔레트용).
 *
 * 훅으로 들고 있지 않는 이유는 위 `ROOMS_KEY` 주석과 같다. 팔레트는 열 때마다 다시
 * 읽으므로, 회의실 뷰에서 방금 바꾼 목록도 별도 동기화 없이 그대로 따라온다.
 */
export function readSavedRooms(): RoomRef[] {
  try {
    const raw = localStorage.getItem(ROOMS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (r): r is RoomRef =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as RoomRef).id === "string" &&
        typeof (r as RoomRef).name === "string"
    )
  } catch {
    return []
  }
}
