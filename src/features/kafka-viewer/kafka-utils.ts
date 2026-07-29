/** Kafka 뷰어 공용 순수 함수 — 포맷팅과 값 해석. */

/** 천단위 구분. */
export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-"
  return n.toLocaleString("ko-KR")
}

/** 바이트 수를 사람이 읽는 크기로. */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "-"
  const units = ["B", "KB", "MB", "GB"]
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`
}

/** epoch millis → `MM-DD HH:mm:ss.SSS` (목록용 짧은 형태). */
export function fmtTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "-"
  const d = new Date(ms)
  const p = (n: number, w = 2) => String(n).padStart(w, "0")
  return (
    `${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  )
}

/** epoch millis → 전체 날짜시간(상세용). */
export function fmtTimeFull(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "-"
  return `${new Date(ms).toLocaleString("ko-KR")} (${ms})`
}

/** `datetime-local` 입력값(로컬 시각) ↔ epoch millis. */
export function localInputToMillis(v: string): number | null {
  if (!v) return null
  const ms = new Date(v).getTime()
  return Number.isFinite(ms) ? ms : null
}

export function millisToLocalInput(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}`
  )
}

/**
 * 값이 JSON 이면 파싱해서 돌려준다(객체/배열일 때만 — 숫자 "123" 은 그대로 문자열로 본다).
 * 메시지 본문을 트리 뷰로 보여 줄지 판단하는 데 쓴다.
 */
export function tryParseJson(text: string | null): unknown | null {
  if (!text) return null
  const t = text.trim()
  if (!t.startsWith("{") && !t.startsWith("[")) return null
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

/** 목록 셀에 넣을 한 줄 미리보기. */
export function preview(text: string | null, max = 300): string {
  if (text === null) return "(null)"
  const one = text.replace(/\s+/g, " ").trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}
