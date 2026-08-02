import { useEffect, useState } from "react"

import { isTauri, trackedInvoke } from "@/lib/tauri"
import codeFrenzyCatSheet from "@/assets/pets/code-frenzy-cat.webp"
import gugaSheet from "@/assets/pets/guga.webp"
import lanlanSheet from "@/assets/pets/lanlan.webp"
import baobaoCoderSheet from "@/assets/pets/baobao-coder.webp"
import cozyFluffSheet from "@/assets/pets/cozy-fluff.webp"
import lemonSheet from "@/assets/pets/lemon.webp"
import luffySheet from "@/assets/pets/luffy.webp"
import maxSheet from "@/assets/pets/max.webp"
import miniJerrySheet from "@/assets/pets/mini-jerry.webp"
import mochiSheet from "@/assets/pets/mochi.webp"
import noirWeblingSheet from "@/assets/pets/noir-webling.webp"
import pinkRibbonChibiSheet from "@/assets/pets/pinkribbonchibi.webp"
import shellpopSnailSheet from "@/assets/pets/shellpop-snail.webp"
import {
  DEFAULT_SPECIES,
  isBuiltinSprite,
  type BuiltinSpriteId,
} from "./pet-species"
import { animPathFor, type PetAnimPaths } from "./pet-anim"
import type { PetAlert, PetMood } from "./use-pet-mood"

/*
 * Petdex / Codex 펫 스프라이트시트 재생.
 *
 * 규격(petdex.dev, README "Pet package format"): 폴더에 `pet.json` + 스프라이트시트,
 * 시트는 **8열 × 9행 = 72프레임**이고 **행이 상태**다. 프레임 크기는 192×208 이지만
 * 여기서는 상수로 믿지 않고 실제 이미지 크기를 열·행으로 나눠 구한다.
 *
 * 까다로운 부분은 프레임 수다. 상태마다 실제로 채워진 프레임 수가 다르고(guga 는 행마다
 * 4~8개) 남는 칸은 완전히 비어 있다. 8프레임으로 돌리면 캐릭터가 주기마다 사라지고,
 * 문서 기본값인 6프레임으로 돌려도 4~5프레임인 행에서는 깜빡인다. 그래서 불러올 때
 * 캔버스로 알파를 훑어 **행마다 앞에서 몇 프레임이 실제로 그려져 있는지** 알아낸다.
 */

/**
 * 시트의 열 수 — 규격 고정값.
 *
 * ⚠️ **행 수는 고정이 아니다.** 규격에서 고정된 것은 프레임 크기(192×208)와 열 수(8)이고,
 * 행은 펫마다 다르다: guga 는 9행(1536×1872)인데 boba 는 11행(1536×2288)이다.
 * 9행으로 못박아 두면 프레임 칸이 254px 로 계산돼 한 칸에 캐릭터가 1.3마리씩 보인다
 * (실제로 그렇게 깨졌다). 그래서 행 수는 이미지 크기에서 구한다.
 */
export const SHEET_COLS = 8

/**
 * 행 → 상태. **petdex 데스크톱 클라이언트의 실제 표**를 그대로 옮겼다
 * (`packages/petdex-desktop-windows/ui/index.html` 의 상태 테이블).
 * 행이 9개보다 많은 펫(boba 는 11행)은 뒤쪽이 추가 상태다 — 앞 9행의 뜻은 같다.
 *
 * ⚠️ petdex README 의 산문 설명은 이것과 다르다 — 9행인데 이름을 8개만 적어 두고
 * 순서도 어긋난다(README 대로 하면 `done` 이 우는 얼굴, `blocked` 가 웃는 얼굴이 된다).
 * 실제 클라이언트의 행별 프레임 수(6·8·8·4·5·8·6·6·6)는 우리가 시트 알파를 훑어 센 값과
 * 정확히 일치했으므로 이 표가 맞다. README 를 근거로 "고치지" 말 것.
 */
export const SHEET_STATES = [
  { name: "idle", frames: 6, durationMs: 1100 },
  { name: "running-right", frames: 8, durationMs: 1060 },
  { name: "running-left", frames: 8, durationMs: 1060 },
  { name: "waving", frames: 4, durationMs: 700 },
  { name: "jumping", frames: 5, durationMs: 840 },
  { name: "failed", frames: 8, durationMs: 1220 },
  { name: "waiting", frames: 6, durationMs: 1010 },
  { name: "running", frames: 6, durationMs: 820 },
  { name: "review", frames: 6, durationMs: 1030 },
] as const

export type SheetState = (typeof SHEET_STATES)[number]["name"]

/**
 * 상태 이름 → 행 번호. 시트에 그 행이 없으면(규격보다 행이 적은 패키지) 0행으로 떨어진다 —
 * 없는 행을 가리키면 빈 칸이 나와 캐릭터가 사라진다.
 */
export function stateRow(name: SheetState, rows: number): number {
  const i = SHEET_STATES.findIndex((s) => s.name === name)
  return i >= 0 && i < rows ? i : 0
}

/**
 * 펫 동작 → 스프라이트 상태(`waiting` 이 아닐 때).
 *
 * `busy`(2건 이상)는 `running-right` 로 — `running`(6프레임)보다 프레임이 많아(8) 더
 * 바쁘게 보이고, 같은 달리기라 동작이 어색하게 튀지 않는다.
 *
 * ⚠️ `idle` 은 "자는 모습"이 되어야 하는데 규격에 잠자는 상태가 없다. 그래서 스프라이트
 * 종류에서는 `idle`(가만히 서 있는 동작)을 쓰고, 자고 있다는 건 머리 위 Zzz 배지가 알린다
 * (pet-character.tsx 의 MoodMark) — 표정을 우리가 그리는 종류는 이제 없다.
 *
 * `running-left` 와 `failed` 는 일부러 비워 둔다. `running-left` 는 `running-right` 의
 * 좌우 반전이라 방향으로는 아무 정보도 전할 수 없고(건수는 머리 위 숫자가 말한다),
 * `failed` 는 붙일 신호 자체가 없다 — herdr `agent_status` 에 실패 값이 없다
 * (`agent-status.ts`: working/blocked/done/idle/unknown). 감시가 켜져 있는데 어느
 * 백엔드도 응답하지 않는 상태를 이벤트로 올리게 되면 그때 `failed` 자리다.
 */
const MOOD_STATE: Record<Exclude<PetMood, "waiting">, SheetState> = {
  idle: "idle",
  running: "running",
  busy: "running-right",
}

/**
 * 동작 + 알림 종류 → 스프라이트 상태.
 *
 * `waiting` 만 알림 종류로 갈린다. 머리 위 배지가 이미 같은 `PetAlert` 로 아이콘을 고르므로
 * (pet-character.tsx 의 MoodMark) 포즈와 배지가 늘 같은 근거를 말하게 된다.
 *
 *  - `input`(AskUserQuestion·권한 요청) → `waving`: 작업이 멈춘 채 사람을 부르는 유일한
 *    상태라 시트에서 가장 빠른 동작(4프레임/700ms)을 준다.
 *  - `done`(작업 완료)  → `jumping`
 *  - `app`(Gmail·Slack·캘린더) → `review`: 작업이 멈춘 게 아니라 "읽을 것이 생겼다"다.
 *  - 그 밖(리마인더 등) → `waiting`: 시간이 되어 얌전히 기다리는 모습. 종류는 빨간 종
 *    배지가 말하므로 동작까지 요란할 필요가 없다.
 */
export function sheetStateFor(
  mood: PetMood,
  alert: PetAlert | null
): SheetState {
  if (mood !== "waiting") return MOOD_STATE[mood]
  switch (alert) {
    case "input":
      return "waving"
    case "done":
      return "jumping"
    case "app":
      return "review"
    default:
      return "waiting"
  }
}

/**
 * 프레임 한 칸의 세로비 — 규격이 192×208 로 못박아 둔 값. 세로로 길다.
 * 창 크기 계산(시트를 읽기 전)과 프레임 높이 계산에 함께 쓴다.
 */
export const SPRITE_ASPECT = 208 / 192

export interface PetSprite {
  slug: string
  name: string
  /** 시트 data URL. */
  sheet: string
  frameW: number
  frameH: number
  /** 이 시트의 실제 행 수(펫마다 다르다). */
  rows: number
  /** 행별로 실제 그려져 있는 프레임 수(빈 칸 제외, 최소 1). */
  rowFrames: number[]
}

/**
 * 앱에 함께 넣어 둔 시트(내장 캐릭터). `~/.petdex` 설치 없이 바로 쓸 수 있어야 하는
 * 기본 캐릭터라서 경로가 아니라 **번들 에셋**으로 들고 있다 — Vite 가 파일로 내보내고
 * URL 만 남으므로 설정(localStorage)에는 아무것도 저장하지 않는다(2MB 짜리를 data URL 로
 * 넣으면 저장 한도를 넘긴다 — `custom` 이미지를 512KB 로 묶어 둔 것과 같은 이유).
 *
 * 시트 규격은 외부 패키지와 완전히 같다(8열 · 행이 상태). 그래서 재생·프레임 스캔 코드는
 * 하나를 그대로 쓰고, 다른 점은 "시트를 어디서 가져오는지"뿐이다.
 */
export const BUILTIN_SHEETS: Record<
  BuiltinSpriteId,
  { name: string; sheet: string }
> = {
  "code-frenzy-cat": { name: "Code Frenzy Cat", sheet: codeFrenzyCatSheet },
  guga: { name: "Guga", sheet: gugaSheet },
  lanlan: { name: "Lanlan", sheet: lanlanSheet },
  "baobao-coder": { name: "Baobao Coder", sheet: baobaoCoderSheet },
  "cozy-fluff": { name: "Cozy Fluff", sheet: cozyFluffSheet },
  lemon: { name: "Lemon", sheet: lemonSheet },
  luffy: { name: "Luffy", sheet: luffySheet },
  max: { name: "Max", sheet: maxSheet },
  "mini-jerry": { name: "mini-Jerry", sheet: miniJerrySheet },
  mochi: { name: "Mochi", sheet: mochiSheet },
  "noir-webling": { name: "Noir Webling", sheet: noirWeblingSheet },
  pinkribbonchibi: { name: "Pink Ribbon Chibi", sheet: pinkRibbonChibiSheet },
  "shellpop-snail": { name: "Shellpop Snail", sheet: shellpopSnailSheet },
}

/** 내장 시트가 있는 종류인지(있으면 이름·시트를 돌려준다). */
export function builtinSheet(
  id: string
): { name: string; sheet: string } | undefined {
  return isBuiltinSprite(id) ? BUILTIN_SHEETS[id] : undefined
}

/**
 * 시트 출처. 문자열 하나로 두는 이유는 이 값이 캐시 key 이면서 훅의 의존성이라서다 —
 * 객체로 넘기면 렌더마다 새 참조가 되어 effect 가 계속 다시 돈다.
 */
export type SpriteSource = string

/** 내장 캐릭터의 출처 key. */
export function builtinSource(id: string): SpriteSource {
  return `builtin:${id}`
}

/** 외부 Petdex 패키지 폴더의 출처 key. */
export function packageSource(dir: string): SpriteSource {
  return `dir:${dir}`
}

/** 무엇을 그릴지 — 스프라이트시트(세로로 긴 프레임)인지 이미지 한 장(정사각)인지. */
export type PetArt =
  | { kind: "sheet"; source: SpriteSource; aspect: number }
  | { kind: "image"; aspect: 1 }

/**
 * 종류·설정에서 "무엇을 그릴지"를 정한다. **한 곳에서** 정하는 이유: 그리는 쪽(펫 창의
 * PetCharacter)과 창 크기를 정하는 쪽(메인 창의 PetController)이 각자 판단하면 첫 표시에서
 * 높이가 어긋나 캐릭터 위가 잘린다(pet-metrics.ts 주석과 같은 이유).
 *
 * 원본을 아직 고르지 않은 가져오기 종류(폴더·이미지 미지정)는 **기본 내장 캐릭터**로
 * 떨어진다 — 펫이 투명한 빈 창으로 뜨면 사용자는 고장으로 읽는다.
 */
export function petArt(pet: {
  species: string
  customImage?: string
  petdexDir?: string
  petdexAspect?: number
  animPaths?: PetAnimPaths
}): PetArt {
  if (isBuiltinSprite(pet.species)) {
    return {
      kind: "sheet",
      source: builtinSource(pet.species),
      aspect: SPRITE_ASPECT,
    }
  }
  if (pet.species === "petdex" && pet.petdexDir) {
    return {
      kind: "sheet",
      source: packageSource(pet.petdexDir),
      // 시트를 읽기 전이라 설정에 저장해 둔 값을 쓴다(없으면 규격값).
      aspect:
        pet.petdexAspect && pet.petdexAspect > 0
          ? pet.petdexAspect
          : SPRITE_ASPECT,
    }
  }
  if (pet.species === "anim" && animPathFor(pet.animPaths, "idle")) {
    return { kind: "image", aspect: 1 }
  }
  if (pet.species === "custom" && pet.customImage) {
    return { kind: "image", aspect: 1 }
  }
  return {
    kind: "sheet",
    source: builtinSource(DEFAULT_SPECIES),
    aspect: SPRITE_ASPECT,
  }
}

/** 같은 시트를 창마다·전환마다 다시 읽지 않도록 출처로 캐시한다(시트가 ~2MB). */
const cache = new Map<SpriteSource, Promise<PetSprite>>()

export function loadPetSprite(src: SpriteSource): Promise<PetSprite> {
  const hit = cache.get(src)
  if (hit) return hit
  const p = read(src).catch((e) => {
    // 실패는 캐시에 남기지 않는다 — 파일을 고치고 다시 고르면 재시도되어야 한다.
    cache.delete(src)
    throw e
  })
  cache.set(src, p)
  return p
}

async function read(src: SpriteSource): Promise<PetSprite> {
  const builtinId = src.startsWith("builtin:") ? src.slice(8) : null
  const pkg = builtinId
    ? await readBuiltin(builtinId)
    : await trackedInvoke<{
        slug: string
        name: string
        sheet: string
      }>("pet_read_package", { dir: src.replace(/^dir:/, "") })

  const img = await decode(pkg.sheet)

  /*
   * 격자는 이미지에서 구한다. 열 수(8)와 프레임 세로비(208/192)만 규격 고정값이므로
   * 프레임 폭 → 프레임 높이 → 행 수 순으로 유도한다. 이렇게 하면 행이 몇 개든(guga 9,
   * boba 11) 2배 크기로 그린 시트든 알아서 맞는다.
   */
  const frameW = Math.round(img.naturalWidth / SHEET_COLS)
  const frameH = Math.round(frameW * SPRITE_ASPECT)
  const rows = Math.max(1, Math.round(img.naturalHeight / frameH))
  if (frameW < 4 || frameH < 4) {
    throw new Error(
      `스프라이트시트 크기가 규격과 다릅니다(${img.naturalWidth}×${img.naturalHeight}, 가로가 ${SHEET_COLS}열이어야 합니다)`
    )
  }

  return {
    slug: pkg.slug,
    name: pkg.name,
    sheet: pkg.sheet,
    frameW,
    frameH,
    rows,
    rowFrames: countFrames(img, frameW, frameH, rows),
  }
}

/** 내장 시트는 읽을 게 없다 — 번들된 URL 을 그대로 쓴다(Rust 호출도 파일 접근도 없다). */
function readBuiltin(id: string): Promise<{
  slug: string
  name: string
  sheet: string
}> {
  const found = builtinSheet(id)
  if (!found) {
    return Promise.reject(new Error(`내장 캐릭터가 아닙니다: ${id}`))
  }
  return Promise.resolve({ slug: id, name: found.name, sheet: found.sheet })
}

function decode(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () =>
      reject(new Error("스프라이트시트를 이미지로 읽을 수 없습니다"))
    img.src = src
  })
}

/**
 * 행마다 앞에서 연속으로 몇 프레임이 채워져 있는지 센다. 첫 빈 칸에서 멈추는 이유:
 * 규격상 프레임은 앞에서부터 채우고 남는 칸을 비워 두므로, 그 지점이 곧 재생 길이다.
 */
function countFrames(
  img: HTMLImageElement,
  frameW: number,
  frameH: number,
  rowCount: number
): number[] {
  const canvas = document.createElement("canvas")
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) return Array.from({ length: rowCount }, () => 1)
  ctx.drawImage(img, 0, 0)

  const rows: number[] = []
  try {
    for (let r = 0; r < rowCount; r++) {
      let n = 0
      for (let c = 0; c < SHEET_COLS; c++) {
        if (!hasPixels(ctx, c * frameW, r * frameH, frameW, frameH)) break
        n = c + 1
      }
      // 한 프레임도 없으면(비어 있는 행) 1로 둬야 나눗셈·모듈러가 깨지지 않는다.
      rows.push(Math.max(1, n))
    }
  } catch {
    // getImageData 가 막히면(캔버스 오염 등) 규격 표의 프레임 수로 돌린다 —
    // 여기서 던지면 시트 전체가 실패해 캐릭터가 아예 안 보인다.
    return specFrames(rowCount)
  }
  return rows
}

/** 알파 스캔이 불가능할 때 쓸 프레임 수 — 규격 표(SHEET_STATES)의 값. */
function specFrames(rowCount: number): number[] {
  return Array.from(
    { length: rowCount },
    (_, r) => SHEET_STATES[r]?.frames ?? 1
  )
}

/** 프레임 칸에 알파가 있는 픽셀이 하나라도 있는지. 8픽셀 간격으로 표본만 본다. */
function hasPixels(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): boolean {
  const { data } = ctx.getImageData(x, y, w, h)
  for (let i = 3; i < data.length; i += 4 * 8) {
    if (data[i] > 8) return true
  }
  return false
}

/** 어떤 출처의 결과인지 함께 들고 있는 상태. */
interface Loaded {
  src: SpriteSource
  sprite: PetSprite | null
  error: string | null
}

/**
 * 불러오는 중·실패까지 함께 돌려주는 훅. `src` 가 null 이면 아무것도 하지 않는다.
 *
 * 결과에 `src` 를 함께 담아 두고 **읽는 시점에** 지금 요청과 맞는지 확인한다.
 * 출처가 바뀔 때 effect 안에서 state 를 비우면 연쇄 렌더가 되기 때문
 * (react-hooks/set-state-in-effect).
 */
export function usePetSprite(src: SpriteSource | null): {
  sprite: PetSprite | null
  error: string | null
} {
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!src) return
    // 외부 패키지만 Rust 를 거친다 — 내장 시트는 번들 에셋이라 웹뷰 밖 의존이 없다.
    if (!src.startsWith("builtin:") && !isTauri()) return
    let alive = true
    void loadPetSprite(src).then(
      (sprite) => {
        if (alive) setLoaded({ src, sprite, error: null })
      },
      (e) => {
        if (alive) setLoaded({ src, sprite: null, error: String(e) })
      }
    )
    return () => {
      alive = false
    }
  }, [src])

  const current = loaded && loaded.src === src ? loaded : null
  return { sprite: current?.sprite ?? null, error: current?.error ?? null }
}
