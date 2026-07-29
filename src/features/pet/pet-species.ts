/*
 * 펫 종류(캐릭터) 목록 — 데이터만. 종류는 두 갈래뿐이다:
 *  - **내장 애니메이션**: 앱에 함께 넣어 둔 Petdex 규격 스프라이트시트(그림 파일은
 *    `pet-sprite.ts` 의 `BUILTIN_SHEETS`).
 *  - **가져오기**: 사용자가 지정한 Petdex 폴더 · 동작별 움직이는 이미지 · 이미지 한 장.
 *
 * 손으로 그린 SVG 도안(고양이·강아지·로봇 …)은 **없다** — 스프라이트 캐릭터와 나란히
 * 두면 품질 차이가 그대로 드러나서 지웠다(`pet-species-art.tsx` 와 눈 좌표 `face`,
 * `pet-character.tsx` 의 Eyes 가 함께 사라졌다). 되살릴 일이 있으면 git 이력에 있다.
 *
 * ★ 종류 추가 지점 ★ — 내장 캐릭터를 늘리려면 `src/assets/pets/` 에 시트를 넣고
 * `BUILTIN_SPRITE_IDS` · `BUILTIN_SHEETS` · `PET_SPECIES` 에 한 줄씩 더하면 설정 화면까지
 * 자동으로 따라온다.
 */

export type PetSpeciesId =
  | "code-frenzy-cat"
  | "guga"
  | "lanlan"
  | "baobao-coder"
  | "petdex"
  | "anim"
  | "custom"

export interface PetSpeciesMeta {
  id: PetSpeciesId
  /** 설정 화면에 보일 이름. */
  name: string
  /** 설정 화면에서 묶어 보여 줄 분류. */
  category: string
}

/**
 * 내장 애니메이션 id 목록 — 앱에 시트를 함께 넣어 둔 캐릭터. 그림 파일은
 * `pet-sprite.ts` 의 `BUILTIN_SHEETS` 가 들고 있고(그쪽은 2MB 에셋을 import 하므로
 * 데이터만 필요한 곳이 끌려 들어오지 않게 id 는 여기 둔다), 두 목록이 어긋나면
 * `Record<BuiltinSpriteId, …>` 타입에서 컴파일이 깨진다.
 */
export const BUILTIN_SPRITE_IDS = [
  "code-frenzy-cat",
  "guga",
  "lanlan",
  "baobao-coder",
] as const

export type BuiltinSpriteId = (typeof BUILTIN_SPRITE_IDS)[number]

/** 내장 애니메이션 종류인지. */
export function isBuiltinSprite(id: string): id is BuiltinSpriteId {
  return (BUILTIN_SPRITE_IDS as readonly string[]).includes(id)
}

/** 기본 종류 — 내장 애니메이션 캐릭터. */
export const DEFAULT_SPECIES: PetSpeciesId = "code-frenzy-cat"

/** 설정 화면에서 내장 애니메이션을 묶어 보여 줄 분류 이름. */
export const BUILTIN_CATEGORY = "내장 애니메이션"

/**
 * 고를 수 있는 캐릭터.
 *  - **내장 애니메이션**: Petdex 규격 스프라이트시트를 앱에 함께 넣어 둔 것
 *    (`pet-sprite.ts` 의 BUILTIN_SHEETS). 설치·설정 없이 바로 움직인다. 설정 화면은 이
 *    줄에 `~/.petdex/pets` 설치분도 함께 세운다(pet-species-settings.tsx).
 *  - `petdex`: 다른 곳에 받아 둔 패키지 폴더를 직접 지정해 재생.
 *  - `anim`: 동작별 GIF·APNG·애니메이션 WebP.
 *  - `custom`: 아무 이미지 한 장(움직임 없음).
 *
 * 내장 애니메이션은 모두 petdex.dev 커뮤니티 패키지 원본이다(출처·주의는
 * `src/assets/pets/README.md`) — 배포 시 라이선스를 확인할 대상이다.
 */
export const PET_SPECIES: PetSpeciesMeta[] = [
  {
    id: "code-frenzy-cat",
    name: "Code Frenzy Cat",
    category: BUILTIN_CATEGORY,
  },
  { id: "guga", name: "Guga", category: BUILTIN_CATEGORY },
  { id: "lanlan", name: "Lanlan", category: BUILTIN_CATEGORY },
  { id: "baobao-coder", name: "Baobao Coder", category: BUILTIN_CATEGORY },
  { id: "petdex", name: "Petdex 폴더", category: "가져오기" },
  { id: "anim", name: "움직이는 이미지", category: "가져오기" },
  { id: "custom", name: "이미지 한 장", category: "가져오기" },
]

/** id → 메타. 모르는 id(설정을 손으로 고친 경우 등)면 기본 종류로 돌린다. */
export function speciesMeta(id: string): PetSpeciesMeta {
  return (
    PET_SPECIES.find((s) => s.id === id) ??
    PET_SPECIES.find((s) => s.id === DEFAULT_SPECIES)!
  )
}
