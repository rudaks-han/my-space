/*
 * 펫이 놓인 자리를 창 밖(localStorage)에 남긴다.
 *
 * 저장 기준은 좌상단이 아니라 **캐릭터 바닥 중앙**이다 — 말풍선이 붙으면 창이 위·양옆으로
 * 커지므로 좌상단은 계속 바뀌지만 바닥 중앙은 그대로다(pet.rs 의 pet_resize 참고).
 *
 * 쓰는 쪽은 펫 창(드래그로 옮긴 뒤), 읽는 쪽은 메인 창의 PetController(다시 띄울 때)로
 * 갈라져 있어 useLocalStorage 훅 대신 단순 함수를 쓴다 — 값이 바뀔 때 리렌더가 필요한
 * 쪽이 없고, 오히려 드래그마다 리렌더·재표시가 걸리면 안 된다.
 */

/** 펫 위치 저장 키. */
export const PET_ANCHOR_KEY = "myspace.petAnchor"

/** 캐릭터 바닥 중앙(논리 좌표). Rust `PetAnchor` 와 대응. */
export interface PetAnchor {
  centerX: number
  bottom: number
}

export function readPetAnchor(): PetAnchor | null {
  try {
    const raw = localStorage.getItem(PET_ANCHOR_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PetAnchor>
    if (
      typeof parsed?.centerX !== "number" ||
      typeof parsed?.bottom !== "number" ||
      !Number.isFinite(parsed.centerX) ||
      !Number.isFinite(parsed.bottom)
    ) {
      return null
    }
    return { centerX: parsed.centerX, bottom: parsed.bottom }
  } catch {
    return null
  }
}

export function writePetAnchor(anchor: PetAnchor): void {
  try {
    localStorage.setItem(PET_ANCHOR_KEY, JSON.stringify(anchor))
  } catch {
    // 저장 실패는 무시 — 다음 실행에 기본 위치로 뜰 뿐이다.
  }
}
