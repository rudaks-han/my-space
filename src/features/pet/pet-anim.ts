import { useEffect, useState } from "react"

import { isTauri, trackedInvoke } from "@/lib/tauri"
import type { PetMood } from "./use-pet-mood"

/*
 * 동작별 애니메이션 이미지(`species: "anim"`).
 *
 * Petdex 스프라이트의 대안이다. 스프라이트시트는 규격(8열·192×208·행별 상태)을 지켜야
 * 하지만 이쪽은 **움직이는 이미지 파일을 동작별로 하나씩** 넣으면 끝이다 — 프레임 격자도,
 * 상태 매핑도, 타이머도 없다. GIF·APNG·애니메이션 WebP 는 웹뷰가 `<img>` 에서 알아서
 * 재생하기 때문이다. 정지 이미지(PNG 등)를 넣어도 그대로 동작한다.
 *
 * 내용을 설정에 저장하지 않고 **경로만** 저장한다 — 움직이는 이미지는 수 MB 가 흔해
 * 네 장을 localStorage 에 박으면 한도를 넘긴다(정지 이미지 한 장인 `custom` 은 반대로
 * 내용을 저장한다. 작고, 파일이 사라져도 살아남는 게 더 중요해서다).
 */

/** 동작별 이미지 경로. 빈 문자열이면 그 동작은 아래 규칙으로 대체된다. */
export type PetAnimPaths = Record<PetMood, string>

export const EMPTY_ANIM_PATHS: PetAnimPaths = {
  idle: "",
  running: "",
  busy: "",
  waiting: "",
}

/** 설정 화면 목록 순서 + 라벨(동작 정의와 같은 문구). */
export const ANIM_SLOTS: { mood: PetMood; label: string; hint: string }[] = [
  { mood: "idle", label: "동작 없음", hint: "자고 있는 모습" },
  { mood: "running", label: "동작 중", hint: "작업 1건 실행 중" },
  { mood: "busy", label: "바쁨", hint: "작업 2건 이상" },
  { mood: "waiting", label: "대기 중", hint: "확인이 필요함" },
]

/**
 * 그 동작에 쓸 경로를 고른다. 없으면 `idle` → 아무거나 채워진 것 순으로 대체한다 —
 * 한 장만 넣어도 펫이 동작하고, 채워 넣는 만큼 동작이 갈린다.
 */
export function animPathFor(
  paths: PetAnimPaths | undefined,
  mood: PetMood
): string {
  if (!paths) return ""
  return (
    paths[mood] ||
    paths.idle ||
    ANIM_SLOTS.map((s) => paths[s.mood]).find(Boolean) ||
    ""
  )
}

/** 경로 → data URL 캐시. 동작이 바뀔 때마다 파일을 다시 읽지 않도록 모듈 수준에 둔다. */
const cache = new Map<string, Promise<string>>()

export function loadPetAnim(path: string): Promise<string> {
  const hit = cache.get(path)
  if (hit) return hit
  const p = trackedInvoke<string>("pet_read_anim", { path }).catch((e) => {
    // 실패는 캐시에 남기지 않는다 — 파일을 고치고 다시 고르면 재시도되어야 한다.
    cache.delete(path)
    throw e
  })
  cache.set(path, p)
  return p
}

/** 어떤 경로의 결과인지 함께 들고 있는 상태(usePetSprite 와 같은 이유). */
interface Loaded {
  path: string
  url: string | null
  error: string | null
}

/**
 * 지금 동작에 맞는 이미지의 data URL. 경로가 없거나 못 읽으면 null —
 * 호출부(pet-character)가 기본 캐릭터로 떨어진다.
 */
export function usePetAnim(
  paths: PetAnimPaths | undefined,
  mood: PetMood
): { url: string | null; error: string | null } {
  const path = animPathFor(paths, mood)
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!path || !isTauri()) return
    let alive = true
    void loadPetAnim(path).then(
      (url) => {
        if (alive) setLoaded({ path, url, error: null })
      },
      (e) => {
        if (alive) setLoaded({ path, url: null, error: String(e) })
      }
    )
    return () => {
      alive = false
    }
  }, [path])

  // 경로가 바뀌면 이전 결과는 무효 — effect 안에서 state 를 비우면 연쇄 렌더가 된다.
  const current = loaded && loaded.path === path ? loaded : null
  return { url: current?.url ?? null, error: current?.error ?? null }
}
