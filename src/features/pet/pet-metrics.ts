/*
 * 펫 창 크기 계산. 캐릭터 크기와 창 크기를 여기 한 곳에서만 만든다.
 *
 * 왜 분리했나: 창을 띄우는 쪽(메인 창의 PetController)과 내용을 그리는 쪽(펫 창의 PetRoot)이
 * 다른 창이라, 두 곳이 크기를 각자 계산하면 어긋난다. 실제로 처음에 그렇게 만들었다가
 * `pet_show` 에 캐릭터 크기(116)를 넘기고 내용은 여백까지 136×134 가 되어, 첫 표시에서
 * 창이 18px 짧아 캐릭터 위쪽(고양이 귀)이 잘렸다. 여백 값도 CSS 클래스가 아니라 여기서
 * 가져다 inline style 로 넣어 둬야 둘이 갈라지지 않는다.
 */

/** 캐릭터 한 변의 기본 크기(px). 설정의 scale 배율을 곱해 쓴다. */
export const PET_BASE = 116

/**
 * 캐릭터 주위 여백. 그림자(`drop-shadow(0 5px 8px …)`)와 기분에 따른 흔들림이
 * 잘리지 않을 만큼만 둔다 — 투명한 여백도 뒤 창의 클릭을 막으므로 넉넉히 두면 안 된다.
 */
export const PET_PAD = { x: 10, top: 4, bottom: 14 } as const

/** 배율을 적용한 캐릭터 한 변. */
export function petCharacterSize(scale: number): number {
  return Math.round(PET_BASE * scale)
}

/**
 * 캐릭터 높이 = 폭 × 세로비. 이미지 종류는 정사각(1)이지만 Petdex 스프라이트는
 * 프레임이 192×208 로 세로로 길다 — 비율을 안 넘기면 첫 표시에서 위가 잘린다.
 */
export function petCharacterHeight(scale: number, aspect = 1): number {
  return Math.round(petCharacterSize(scale) * (aspect > 0 ? aspect : 1))
}

/**
 * 말풍선이 없을 때의 창 크기 = 캐릭터 + 여백.
 * 말풍선이 붙으면 PetRoot 가 실제 내용을 재서 `pet_resize` 로 다시 맞춘다.
 */
export function petWindowSize(
  scale: number,
  aspect = 1
): { width: number; height: number } {
  return {
    width: petCharacterSize(scale) + PET_PAD.x * 2,
    height: petCharacterHeight(scale, aspect) + PET_PAD.top + PET_PAD.bottom,
  }
}
