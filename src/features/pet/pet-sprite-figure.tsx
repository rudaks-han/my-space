import { useEffect, useState } from "react"

import type { PetMood } from "./use-pet-mood"
import {
  MOOD_STATE,
  SHEET_COLS,
  SHEET_STATES,
  stateRow,
  type PetSprite,
} from "./pet-sprite"

/**
 * 스프라이트시트 한 프레임을 그리고 상태(행)를 따라 재생한다.
 *
 * `background-position` 을 프레임 폭만큼 밀어 넘긴다 — <img> 여러 장이나 canvas 보다
 * 가볍고, 시트를 한 번만 디코딩한다. 배율은 `background-size` 로 준다.
 *
 * `.pet-figure`(호흡·까딱·흔들림 CSS)를 일부러 붙이지 않는다 — 그림 자체가 이미 움직이므로
 * 겹치면 어지럽다. 그림자만 주는 `.pet-sprite` 를 쓴다.
 */
export function PetSpriteFigure({
  sprite,
  mood,
  width,
}: {
  sprite: PetSprite
  mood: PetMood
  width: number
}) {
  const row = stateRow(MOOD_STATE[mood], sprite.rows)
  const spec = SHEET_STATES[row] ?? SHEET_STATES[0]
  // 실제로 그려져 있는 프레임 수를 우선한다(규격을 어긋나게 만든 패키지가 있을 수 있다).
  // 표의 값은 스캔이 실패했을 때의 보루.
  const frames = sprite.rowFrames[row] || spec.frames
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (frames <= 1) return
    const id = setInterval(
      () => setTick((t) => t + 1),
      Math.max(60, Math.round(spec.durationMs / frames))
    )
    return () => clearInterval(id)
  }, [row, frames, spec.durationMs])

  // 재생 위치는 tick 에서 유도한다. 상태가 바뀔 때 0으로 되돌리지 않는 이유는 두 가지다:
  // effect 안에서 state 를 되돌리면 연쇄 렌더가 되고(react-hooks/set-state-in-effect),
  // frames 는 실제로 채워진 프레임 수라 어느 번호로 시작해도 빈 칸이 나오지 않는다.
  const frame = tick % frames

  const height = Math.round((width * sprite.frameH) / sprite.frameW)

  return (
    <div
      className="pet-sprite"
      style={{
        width,
        height,
        backgroundImage: `url(${sprite.sheet})`,
        // 행 수는 시트마다 다르므로 실제 값을 쓴다 — 9로 못박으면 칸이 어긋나
        // 한 칸에 캐릭터가 1.3마리씩 보인다.
        backgroundSize: `${width * SHEET_COLS}px ${height * sprite.rows}px`,
        backgroundPosition: `${-frame * width}px ${-row * height}px`,
        backgroundRepeat: "no-repeat",
      }}
    />
  )
}
