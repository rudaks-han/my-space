import { useCallback, useEffect, useMemo, useRef, useState } from "react"

/**
 * id 배열이 같은 내용인지 — 이 훅 안에서만 쓰는 비교다.
 *
 * 최적화가 아니라 **필수 장치**다. `measure` 는 ResizeObserver 틱마다, 그리고 가로
 * 스크롤 이벤트마다 돈다. 매번 새 배열을 그대로 setState 하면 내용이 똑같아도 신원이
 * 달라 탭 행이 끊임없이 리렌더된다(스크롤 중이면 프레임마다).
 */
function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/**
 * `ids.join()` 에 쓰는 구분자. 탭 id 에 절대 들어갈 수 없는 문자여야 하는데, 이 훅이
 * 받는 id 는 메뉴 id 일 수도 있고 파일 경로일 수도 있어(IntelliJ Cowork 의 내부 탭) 공백·`/`·
 * `:` 는 전부 후보에서 빠진다. NUL 만 안전하다.
 */
const SEP = "\u0000"

/**
 * IntelliJ 식 "⌄ 가려진 탭 목록" 을 위한 넘침 측정 훅.
 *
 * 탭은 줄어들지 않는 대신(`shrink-0` + 최소 폭) 행이 넘치면 가로 스크롤되므로,
 * "지금 화면 밖으로 밀려난 탭이 무엇인지"를 레이아웃에서 직접 읽어야 한다. 셸의 탭 행
 * (`components/shell/tab-bar.tsx`)과 IntelliJ Cowork 화면의 내부 탭 행이 같은 계산을
 * 쓰기 때문에 여기로 뽑아 두었다.
 *
 * 상태를 두 개로 나눠 두는 것은 의도다: `overflowing` 은 ⌄ 버튼을 **아예 그릴지**를
 * 정하고, `hiddenIds` 는 그 버튼의 배지 숫자에만 쓴다. 넘치는데 마침 경계에 걸린 탭이
 * 없어 `hiddenIds` 가 빈 순간에도 버튼은 남아 있어야 한다 — 스크롤할 곳이 있다는 사실은
 * 변하지 않으므로 버튼이 깜빡이며 사라지면 안 된다.
 *
 * 판정은 `getBoundingClientRect` 가 아니라 `offsetLeft` 를 `scrollLeft` 와 비교한다.
 * 그래서 **스크롤러 자신이 offsetParent 여야** 하고, 곧 스크롤러에 `relative` 가
 * 붙어 있어야 한다. 빠뜨리면 좌표 기준이 조상 요소로 올라가 엉뚱한 탭이 가려진 것으로
 * 잡힌다(오류는 없다). ±1px 여유는 소수점 레이아웃에서 딱 맞는 탭이 가려진 것으로
 * 잡히는 걸 막는다.
 *
 * 호출 측이 지켜야 할 계약이 두 가지다:
 * 1. 스크롤러에 `ref={scrollRef}` · `relative`(위 참조) · `onScroll={measure}` —
 *    ResizeObserver 는 크기 변화만 알려 주므로 가로 스크롤은 따로 붙여야 한다.
 * 2. ⌄ 버튼은 스크롤러 **밖의 형제**로 두고 스크롤러를 `min-w-0 flex-1` 로 둔다.
 *    안에 넣으면 버튼의 존재가 `clientWidth` 를 바꾸고, 그 `clientWidth` 가 다시
 *    `overflowing` 을 정하므로 켜짐↔꺼짐이 진동한다. 밖에 두면 버튼은 스크롤러를
 *    좁히기만 하므로 넘침이 더 참이 되는 방향뿐이고, 그래서 한 번에 수렴한다.
 *
 * @param ids 탭 id 를 **표시 순서대로**. 이 순서대로 훑기 때문에 배지 숫자와 목록
 *   순서가 탭 순서와 어긋나지 않는다. 인라인 배열(`map` 결과)을 넘겨도 되도록 내용
 *   기준으로 고정하므로, 그때도 `measure` 의 신원이 렌더마다 흔들리지 않는다.
 * @param activeId 활성 탭 id. 바뀔 때마다 보이는 위치로 끌어온다(목록에서 고른 탭이
 *   화면 밖에 있으면 골라도 아무 일이 없어 보이므로).
 */
export function useTabOverflow(ids: string[], activeId: string | null) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // 탭 id → DOM 노드. 측정에 쓰고, 좌표로 탭을 찾아야 하는 호출 측(드래그 재정렬)에도
  // 그대로 넘긴다 — 같은 노드를 담은 Map 을 두 벌 들고 다니지 않기 위해서다.
  const nodes = useRef(new Map<string, HTMLElement>())
  // 스크롤 영역 밖으로 밀려난 탭 id(목록 버튼의 배지 숫자 = 이 개수).
  const [hiddenIds, setHiddenIds] = useState<string[]>([])
  const [overflowing, setOverflowing] = useState(false)

  // 내용이 같으면 같은 배열을 유지한다. 그렇지 않으면 아래 effect 가 렌더마다
  // ResizeObserver 를 떼고 다시 붙인다(동작은 하지만 매 렌더 재측정이 된다).
  const orderKey = ids.join(SEP)
  const order = useMemo(
    () => (orderKey === "" ? [] : orderKey.split(SEP)),
    [orderKey]
  )

  const tabRef = useCallback(
    (id: string) => (node: HTMLElement | null) => {
      if (node) nodes.current.set(id, node)
      else nodes.current.delete(id)
    },
    []
  )

  const measure = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setOverflowing(el.scrollWidth > el.clientWidth + 1)
    const left = el.scrollLeft
    const right = left + el.clientWidth
    const hidden: string[] = []
    // 받은 순서대로 훑어 배지/목록 순서가 탭 순서와 어긋나지 않게 한다.
    for (const id of order) {
      const node = nodes.current.get(id)
      if (!node) continue
      // 1px 여유 — 소수점 레이아웃에서 딱 맞는 탭이 가려진 것으로 잡히는 걸 막는다.
      if (
        node.offsetLeft < left - 1 ||
        node.offsetLeft + node.offsetWidth > right + 1
      ) {
        hidden.push(id)
      }
    }
    setHiddenIds((prev) => (sameIds(prev, hidden) ? prev : hidden))
  }, [order])

  // 탭 추가/삭제, 창 크기 변경, 가로 스크롤 모두 가려짐 여부를 바꾼다
  // (스크롤은 호출 측의 `onScroll={measure}` 가 담당한다).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure])

  // 활성 탭이 가려진 곳(목록에서 고른 탭 등)이면 보이는 위치로 끌어온다.
  useEffect(() => {
    if (!activeId) return
    nodes.current
      .get(activeId)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [activeId])

  return { scrollRef, tabRef, nodes, overflowing, hiddenIds, measure }
}
