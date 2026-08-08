import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"

import { trackedInvoke } from "@/lib/tauri"
import { useSettings } from "@/features/settings/settings-context"
import { PET_PAD, petCharacterSize } from "./pet-metrics"
import { PetCharacter } from "./pet-character"
import { PetBubble } from "./pet-bubble"
import { usePetMood } from "./use-pet-mood"
import { writePetAnchor, type PetAnchor } from "./pet-anchor"
import { usePetFeedCounts } from "./pet-feed"
import { PetDial } from "./pet-dial"
import { toDialItems } from "./pet-dial-items"

/** 드래그로 인정할 최소 이동 거리(px). 이보다 작게 움직이면 클릭으로 본다. */
const DRAG_THRESHOLD = 4
/** 창을 옮긴 뒤 위치를 저장하기까지 기다리는 시간 — 드래그 중 저장이 쏟아지지 않게. */
const SAVE_DEBOUNCE_MS = 250

/**
 * 펫 창(`pet`)의 진입점 — 화면 위에 상시 떠 있는 캐릭터.
 *
 * 창을 **내용 크기에 딱 맞춘다**(pet_resize). 투명한 빈 영역도 마우스 클릭을 먹기 때문에,
 * 창이 내용보다 크면 그만큼 뒤 창을 못 누르게 된다. 말풍선이 뜨고 지는 것까지 크기에
 * 반영되므로 ResizeObserver 로 계속 따라간다.
 *
 * 조작 세 가지:
 *  - 캐릭터를 **끌면** 창이 움직인다(놓은 자리는 저장).
 *  - 캐릭터를 **누르면** 빠른 이동 다이얼이 위로 펼쳐진다(Speed Dial). 아이콘마다 안읽음
 *    뱃지가 붙고, 누르면 그 메뉴로 간다(`pet_open_menu`).
 *  - **머리 위 표시를 누르면** 진행 중인 Claude 작업만 펼쳐진다(어떤 프롬프트였는지).
 *    Slack·Gmail 건수는 여기가 아니라 다이얼 뱃지가 맡는다 — 성격이 다른 정보를 한 목록에
 *    섞으면 무엇을 보는 화면인지 흐려진다.
 *
 * 숨기려면 설정에서 "상시 표시"를 끈다 — 펫(창) 자체에는 닫기 버튼을 두지 않는다
 * (캐릭터를 가리고, 드래그·클릭과 손이 겹친다). 알림 카드의 X 는 그 알림 한 건만 치우는
 * 것으로, 창을 숨기지 않는다.
 */
export function PetRoot() {
  const { settings } = useSettings()
  const pet = settings.pet
  // 알림 유지 시간은 설정에서 — 0 이면 치울 때까지 남는다.
  // Claude Code 알림은 여기서도 걸러야 한다: 상시 표시로 떠 있는 펫은 Rust 의 알림 축과
  // 무관하게 herdr 이벤트를 계속 받으므로, 설정에서 꺼도 말풍선은 그대로 뜬다.
  const state = usePetMood({
    noticeMs: Math.max(0, pet.noticeSeconds ?? 12) * 1000,
    claudeNotices: pet.notify.claude,
    claudeTarget: pet.notify.claudeTarget,
    slackTarget: pet.notify.slackTarget,
  })
  const size = petCharacterSize(pet.scale)
  const boxRef = useRef<HTMLDivElement>(null)
  /** 크기 재적용 함수 — `pet:shown` 리스너가 다른 effect 에서 부를 수 있게 ref 로 들고 있다. */
  const syncSize = useRef<(force?: boolean) => void>(() => {})

  // 내용 크기 → 창 크기. pet_resize 가 바닥 중앙을 고정하므로 말풍선은 위로만 자란다.
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    let last = ""
    const sync = (force = false) => {
      const r = el.getBoundingClientRect()
      const width = Math.ceil(r.width)
      const height = Math.ceil(r.height)
      if (width < 8 || height < 8) return
      const key = `${width}x${height}`
      // 같은 크기를 되풀이해 보내지 않는다. 단 창을 다시 띄운 직후(force)는 예외 —
      // 내용은 그대로여도 pet_show 가 창 크기를 기본값으로 돌려놨을 수 있다.
      if (key === last && !force) return
      last = key
      void trackedInvoke("pet_resize", { width, height })
    }
    syncSize.current = sync
    sync()
    const ro = new ResizeObserver(() => sync())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /*
   * 창이 다시 떠도 크기를 맞춘다. 창 크기는 pet_show 가, 내용 크기는 여기가 정하는데
   * 다시 띄울 때 내용은 안 바뀌어서 ResizeObserver 가 안 울린다 — 말풍선이 떠 있는 상태로
   * 껐다 켜면 창이 캐릭터 크기로 줄어든 채 말풍선이 잘린다. Rust 가 표시 직후 알려 준다.
   */
  useEffect(() => {
    const unlisten = listen("pet:shown", () => syncSize.current(true))
    return () => void unlisten.then((f) => f())
  }, [])

  // 클릭 통과 설정 반영(장식 모드 — 켜면 아래의 드래그·클릭도 못 받는다).
  useEffect(() => {
    void trackedInvoke("pet_set_click_through", { enabled: pet.clickThrough })
  }, [pet.clickThrough])

  // 창이 움직이면(드래그·경계 보정) 바닥 중앙을 저장해 둔다 → 다음에 같은 자리에서 뜬다.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unlisten = getCurrentWindow().onMoved(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void trackedInvoke<PetAnchor | null>("pet_anchor").then((a) => {
          if (a) writePetAnchor(a)
        })
      }, SAVE_DEBOUNCE_MS)
    })
    return () => {
      if (timer) clearTimeout(timer)
      void unlisten.then((f) => f())
    }
  }, [])

  /*
   * 드래그와 클릭을 한 제스처에서 가른다. 네이티브 창 드래그(startDragging)를 pointerdown 에
   * 바로 걸면 클릭이 영원히 안 되므로, 일정 거리 이상 움직인 다음에야 드래그로 넘긴다.
   * (드래그가 시작되면 pointerup 이 웹뷰로 안 오지만, 다음 pointerdown 이 상태를 새로 쓴다.)
   */
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    drag.current = { x: e.clientX, y: e.clientY, moved: false }
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.moved) return
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD) return
    d.moved = true
    void getCurrentWindow().startDragging()
  }, [])

  /*
   * 위로 펼쳐지는 것은 두 가지이고 **서로 배타적**이다(둘이 겹치면 창이 화면을 덮는다):
   *  - "dial"  : 캐릭터를 누르면 나오는 빠른 이동 아이콘 + 안읽음 뱃지.
   *  - "tasks" : 머리 위 표시를 누르면 나오는 **Claude Code 진행 작업**만.
   * 진행 작업을 저절로 띄우지는 않는다 — 끝날 때까지 떠 있으면 방해만 되므로 누를 때만.
   */
  const [overlay, setOverlay] = useState<"none" | "dial" | "tasks">("none")

  const onPointerUp = useCallback(() => {
    const d = drag.current
    drag.current = null
    if (!d || d.moved) return
    setOverlay((v) => (v === "dial" ? "none" : "dial"))
  }, [])

  const counts = usePetFeedCounts()
  const dialItems = useMemo(
    () => toDialItems(pet.dialMenus ?? [], counts),
    [pet.dialMenus, counts]
  )

  const openMenu = useCallback((menuId: string) => {
    setOverlay("none")
    void trackedInvoke("pet_open_menu", { menuId })
  }, [])

  const notices = pet.bubble ? state.notices : []
  const taskRows = overlay === "tasks" ? state.tasks : []
  const rows = [...notices, ...taskRows]
  // 눌렀는데 아무 반응이 없는 것보다, 진행 중인 게 없다고 말해 주는 편이 낫다.
  const showQuiet =
    overlay === "tasks" && taskRows.length === 0 && notices.length === 0

  /*
   * 머리 위 배지 아이콘은 "무엇을 확인해야 하는지"로 갈린다. 말풍선을 꺼 뒀거나
   * 스프라이트·이미지 종류라 표정이 없을 때 이게 유일한 단서이므로, 말풍선 표시 설정과
   * 무관하게 state.notices(원본)에서 뽑는다.
   */
  const alert = state.notices[0]?.kind ?? null

  return (
    // 바닥 중앙 기준으로 쌓는다 — pet_resize 가 고정하는 지점과 같아야 캐릭터가 안 흔들린다.
    // 여백은 Tailwind 클래스가 아니라 pet-metrics 의 PET_PAD 에서 가져온다 —
    // PetController 가 첫 창 크기를 같은 값으로 계산하므로 둘이 갈라지면 캐릭터가 잘린다.
    <div
      ref={boxRef}
      style={{
        paddingLeft: PET_PAD.x,
        paddingRight: PET_PAD.x,
        paddingTop: PET_PAD.top,
        paddingBottom: PET_PAD.bottom,
      }}
      className="fixed bottom-0 left-1/2 flex w-max -translate-x-1/2 flex-col items-center"
    >
      {overlay === "dial" && (
        <div className="mb-2">
          <PetDial items={dialItems} onPick={openMenu} />
        </div>
      )}

      {rows.length > 0 && (
        <div className="mb-[7px]">
          <PetBubble notices={rows} />
        </div>
      )}
      {showQuiet && (
        <div className="pet-bubble mb-[7px] w-[248px] rounded-[10px] bg-background px-2.5 py-2 text-[13px] font-semibold text-muted-foreground shadow-[0_4px_16px_rgba(0,0,0,0.16)]">
          진행 중인 Claude 작업이 없습니다.
        </div>
      )}

      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="cursor-pointer"
      >
        <PetCharacter
          mood={state.mood}
          size={size}
          species={pet.species}
          customImage={pet.customImage || undefined}
          petdexDir={pet.petdexDir || undefined}
          petdexAspect={pet.petdexAspect}
          animPaths={pet.animPaths}
          running={state.running}
          alert={alert}
          onMarkClick={() =>
            setOverlay((v) => (v === "tasks" ? "none" : "tasks"))
          }
        />
      </div>
    </div>
  )
}
