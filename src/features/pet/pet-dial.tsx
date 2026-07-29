import type { PetDialItem } from "./pet-dial-items"

/**
 * 캐릭터를 누르면 위로 펼쳐지는 빠른 이동 아이콘들(MUI Speed Dial 형태).
 *
 * 배열 순서상 첫 항목이 캐릭터에 가장 가깝게 놓이도록 `flex-col-reverse` 를 쓴다
 * (Speed Dial 의 규칙: 먼저 온 것이 버튼에 가깝다). 펼쳐지는 느낌은 항목별 지연으로 준다.
 *
 * 창은 내용 크기에 맞춰지므로 라벨을 늘 띄우면 폭이 그만큼 커져 뒤 창을 가린다 —
 * 이름은 네이티브 툴팁(title)으로만 보여 준다.
 */
export function PetDial({
  items,
  onPick,
}: {
  items: PetDialItem[]
  onPick: (menuId: string) => void
}) {
  if (items.length === 0) return null

  return (
    <div className="flex flex-col-reverse items-center gap-1.5">
      {items.map((item, i) => (
        <button
          key={item.menuId}
          type="button"
          title={item.title}
          aria-label={item.title}
          onClick={() => onPick(item.menuId)}
          style={{ animationDelay: `${i * 35}ms` }}
          className="pet-dial-item relative flex size-[34px] cursor-pointer items-center justify-center rounded-full bg-background shadow-[0_4px_16px_rgba(0,0,0,0.16)] transition-colors hover:bg-ui-list-hover"
        >
          <item.Icon className="size-[18px]" />
          {item.count > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[16px] rounded-full bg-ui-error px-1 text-center text-[10px] leading-4 font-bold text-white tabular-nums">
              {item.count > 99 ? "99+" : item.count}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
