/*
 * 본문 글자 크기 목록(설정 → Appearance → Font Size).
 *
 * 폰트 종류가 `--ui-font` 하나로 끝나는 것과 달리 크기는 **배율**(`--ui-font-scale`)로
 * 다룬다 — 이 앱의 글자 크기는 Slack 규칙에 따라 대부분 px 리터럴(`text-[13px]` 1000여 곳)로
 * 박혀 있어서 "본문만 키운다" 가 성립하지 않기 때문이다. 기준값 15px 에 대한 비율 하나를
 * 정해 두면 index.css 가 px 유틸·rem 간격·셸 높이를 한꺼번에 같은 비율로 다시 계산한다.
 *
 * 그래서 여기 px 값은 "본문 크기" 이자 곧 배율의 분자다. 실제 적용은 theme-preset-provider
 * 가 `--ui-font-scale` 을 <head> <style> 로 주입하는 방식이며, 나머지는 전부 css 가 한다.
 */
export interface AppFontSize {
  /** 저장·식별용 id. px 값을 바꿔도 사용자의 선택("크게")은 유지되도록 의미 이름을 쓴다. */
  id: string
  /** 설정 화면에 보이는 이름 — 결과 본문 크기(px)를 그대로 보여 준다. */
  label: string
  /** 이 단계에서의 본문 크기(px). */
  px: number
}

/** 배율 1 에 해당하는 본문 크기 — index.css 의 `html { font-size }` 기준값(Slack 본문 크기). */
export const BASE_FONT_PX = 15

export const FONT_SIZES: AppFontSize[] = [
  { id: "xs", label: "13", px: 13 },
  { id: "sm", label: "14", px: 14 },
  { id: "md", label: "15", px: BASE_FONT_PX },
  { id: "lg", label: "16", px: 16 },
  { id: "xl", label: "17", px: 17 },
]

/** 기본 글자 크기 id — 15px(Slack 본문 크기). */
export const DEFAULT_FONT_SIZE_ID = "md"

const DEFAULT_FONT_SIZE =
  FONT_SIZES.find((s) => s.id === DEFAULT_FONT_SIZE_ID) ?? FONT_SIZES[0]

/** id 로 크기를 찾는다. 없으면 기본(15px). */
export function getFontSize(id: string | null | undefined): AppFontSize {
  return FONT_SIZES.find((s) => s.id === id) ?? DEFAULT_FONT_SIZE
}

/**
 * `--ui-font-scale` 에 넣을 배율. 소수점이 길어지면 calc 결과가 반픽셀에 걸려 글자가
 * 흐려지므로 셋째 자리에서 끊는다.
 */
export function fontScale(size: AppFontSize): number {
  return Math.round((size.px / BASE_FONT_PX) * 1000) / 1000
}
