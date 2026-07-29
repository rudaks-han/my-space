import type { ReactNode } from "react"
import { BellRingIcon, SparklesIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import type { PetAlert, PetMood } from "./use-pet-mood"
import { speciesMeta } from "./pet-species"
import { petArt, usePetSprite } from "./pet-sprite"
import { PetSpriteFigure } from "./pet-sprite-figure"
import { usePetAnim, type PetAnimPaths } from "./pet-anim"

/**
 * 데스크톱 펫 캐릭터. 종류는 `pet-species.ts` 가 정하고, 무엇을 그릴지는 `petArt()` 가
 * 한 곳에서 정한다(창 크기를 정하는 PetController 와 같은 판단을 써야 하므로).
 *
 * 표정을 우리가 그리지는 않는다 — 손으로 그린 SVG 도안은 스프라이트 캐릭터와 나란히 두면
 * 품질 차이가 그대로 보여 지웠다. 그래서 캐릭터는 세 갈래뿐이고 셋 다 그림이 표정을 맡는다:
 *  - **스프라이트시트**(내장 애니메이션 · `petdex`): 동작이 시트의 상태(행)로 표현되므로
 *    우리 CSS 애니메이션은 걸지 않는다(pet-sprite-figure).
 *  - `anim`: 동작별로 지정한 움직이는 이미지(GIF·APNG·애니메이션 WebP)를 그대로 쓴다.
 *    웹뷰가 재생하므로 프레임 처리가 없다(pet-anim.ts). 역시 CSS 애니메이션은 걸지 않는다.
 *  - `custom`: 이미지 한 장이라 표정 변화가 없다 — 동작은 CSS 움직임(`.pet-mood-*`)과
 *    머리 위 배지로만 드러난다.
 *
 * 어느 쪽이든 지금 무슨 동작인지는 머리 위 배지(MoodMark)가 알린다.
 */
export function PetCharacter({
  mood,
  size,
  species,
  customImage,
  petdexDir,
  petdexAspect,
  animPaths,
  running = 0,
  alert = null,
  onMarkClick,
}: {
  mood: PetMood
  size: number
  species: string
  /** 실행 중인 작업 수 — `busy` 배지의 숫자. */
  running?: number
  /** `waiting` 일 때 무엇을 확인해야 하는지 — 배지 아이콘이 갈린다. */
  alert?: PetAlert | null
  /** `custom` 종류일 때 쓸 이미지(data URL). 없으면 기본 종류로 떨어진다. */
  customImage?: string
  /** `petdex` 종류일 때 읽을 패키지 폴더. */
  petdexDir?: string
  /** 스프라이트 세로비. 시트를 읽기 전에도 자리를 정확히 잡으려고 미리 받는다. */
  petdexAspect?: number
  /** `anim` 종류일 때 동작별로 재생할 이미지 경로. */
  animPaths?: PetAnimPaths
  /**
   * 머리 위 표시를 눌렀을 때(상태 패널 펼치기). 주면 배지가 버튼이 된다 —
   * 캐릭터 클릭·드래그와 겹치지 않도록 포인터 이벤트를 여기서 멈춘다.
   */
  onMarkClick?: () => void
}) {
  const meta = speciesMeta(species)
  /*
   * 내장 애니메이션과 가져온 petdex 패키지는 시트 규격이 같아 재생 경로가 하나다 —
   * 다른 건 시트를 번들에서 가져오는지 폴더에서 읽는지뿐이다. 원본을 아직 안 고른
   * 가져오기 종류는 `petArt` 가 기본 내장 캐릭터로 떨어뜨린다(빈 창 방지).
   */
  const art = petArt({
    species: meta.id,
    customImage,
    petdexDir,
    petdexAspect,
    animPaths,
  })
  const isAnim = meta.id === "anim"
  // 훅은 조건 없이 부른다 — 시트가 아니면 빈 값을 넘겨 아무것도 읽지 않는다.
  const { sprite } = usePetSprite(art.kind === "sheet" ? art.source : null)
  const { url: animUrl } = usePetAnim(isAnim ? animPaths : undefined, mood)

  // 스프라이트 프레임은 세로로 길다(192×208). 시트를 읽는 동안에도 같은 높이를 잡아 둬야
  // 다 읽힌 순간 창이 덜컥 커지지 않는다.
  const height = Math.round(size * art.aspect)

  return (
    <div
      className={cn(
        "relative select-none",
        // 스프라이트·움직이는 이미지는 그림이 알아서 움직이므로 기분 클래스를 붙이지 않는다
        // (붙이면 CSS 흔들림과 겹쳐 어지럽다). 이미지 한 장만 CSS 로 움직인다.
        art.kind === "image" && !isAnim && `pet-mood-${mood}`
      )}
      style={{ width: size, height }}
    >
      {art.kind === "sheet" ? (
        sprite ? (
          <PetSpriteFigure sprite={sprite} mood={mood} width={size} />
        ) : (
          // 아직 읽는 중(또는 폴더가 잘못됨) — 자리만 비워 둔다.
          <div style={{ width: size, height }} />
        )
      ) : isAnim ? (
        /* GIF·APNG·애니메이션 WebP 는 웹뷰가 알아서 재생한다 — 프레임 처리가 없다.
           비율은 제각각이므로 정사각 칸에 object-contain 으로 맞춘다(창 크기가 흔들리지 않게).
           읽는 중(animUrl 이 아직 null)에는 자리만 비워 둔다 — 다른 그림으로 한 번 깜빡이는
           것보다 낫다. */
        animUrl && (
          <img
            src={animUrl}
            alt=""
            draggable={false}
            width={size}
            height={size}
            className="pet-sprite size-full object-contain"
          />
        )
      ) : (
        <img
          src={customImage}
          alt=""
          draggable={false}
          width={size}
          height={size}
          className="pet-figure size-full object-contain"
        />
      )}

      <MoodMark
        mood={mood}
        running={running}
        alert={alert}
        onClick={onMarkClick}
      />
    </div>
  )
}

/**
 * 머리 위 표시 — 지금 무슨 동작인지 한눈에 알리는 작은 배지.
 *
 * DOM 요소로 그리는 이유: 스프라이트·이미지 종류에는 표정이 없어서(그리고 규격에 잠자는
 * 상태가 없어서) 이 배지가 유일한 단서다. SVG 안에 넣으면 종류별 머리 위치를 다 알아야 한다.
 *
 * 색은 상태 칩(`agent-status.ts`)과 맞춘다: 입력 대기 = warning, 완료 = info.
 * 리마인더는 Claude 상태가 아니라 error 로 구분한다.
 */
function MoodMark({
  mood,
  running,
  alert,
  onClick,
}: {
  mood: PetMood
  running: number
  alert: PetAlert | null
  onClick?: () => void
}) {
  const body =
    mood === "idle" ? (
      // 자고 있음 — Zzz. 종류와 무관하게 "지금 아무 일도 없다"를 알린다.
      <span className="pet-zzz text-[15px] leading-none font-bold text-ui-chrome/70">
        z<span className="text-[12px]">z</span>
      </span>
    ) : mood === "waiting" ? (
      // 대기 중 — 무엇을 확인해야 하는지에 따라 아이콘이 갈린다.
      alert === "reminder" ? (
        <Badge className="bg-ui-error">
          <BellRingIcon className="size-3.5" />
        </Badge>
      ) : alert === "done" ? (
        <Badge className="bg-ui-info">
          <SparklesIcon className="size-3.5" />
        </Badge>
      ) : (
        <Badge className="bg-ui-warning text-[14px] font-bold">!</Badge>
      )
    ) : mood === "busy" ? (
      // 바쁨 — 몇 건이 동시에 돌고 있는지 숫자로.
      <Badge className="bg-ui-success text-[12px] font-bold">{running}</Badge>
    ) : (
      // 동작 중 — 흐르는 점 세 개.
      <span className="flex items-center gap-[3px] rounded-full bg-white/95 px-1.5 py-1 shadow-[0_2px_6px_rgba(0,0,0,0.2)]">
        {[0, 1, 2].map((i) => (
          <i key={i} className="pet-dot size-[4px] rounded-full bg-ui-chrome" />
        ))}
      </span>
    )

  if (!onClick) {
    return <span className="absolute top-0 right-0 select-none">{body}</span>
  }

  return (
    <button
      type="button"
      aria-label="펫 상태 보기"
      // 캐릭터의 드래그·클릭 판정과 겹치지 않게 포인터 이벤트를 여기서 멈춘다
      // (안 멈추면 배지를 눌러도 캐릭터 클릭으로 함께 처리돼 메뉴가 열린다).
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="absolute top-0 right-0 cursor-pointer outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid"
    >
      {body}
    </button>
  )
}

/** 머리 위 원형 배지 공통 껍데기. */
function Badge({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        "flex size-[22px] items-center justify-center rounded-full text-white shadow-[0_2px_6px_rgba(0,0,0,0.25)]",
        className
      )}
    >
      {children}
    </span>
  )
}
