import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/*
 * Slack 버튼 톤: 8px 라운드, 15px/bold 글자, 32px 기본 높이. 그림자는 쓰지 않되
 * 글자 굵기와 여백으로 무게를 준다(Slack 은 버튼 라벨을 늘 굵게 쓴다).
 * 알약 버튼이 필요한 곳(필터·날짜 구분선 등)은 호출 쪽에서 `rounded-full` 을 덧붙인다.
 * 포커스는 Slack 처럼 2px 파란 링 + 1px 바깥 여백.
 * (base 의 `outline-none` 이 --tw-outline-style 을 none 으로 눌러 두므로
 *  focus-visible 에서 `outline-solid` 로 되살려야 실제로 선이 보인다.)
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-[15px] font-bold whitespace-nowrap transition-colors outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Slack 그린 → hover 는 한 톤 밝은 그린(투명도 대신 실색을 써서 배경이 비치지 않게).
        default:
          "bg-primary text-primary-foreground hover:bg-[#148567] dark:hover:bg-[#1A9C78]",
        // Slack 우측 상단 버튼 군: 채움 없는 1px 테두리 + hover 시 옅은 회색 배경.
        outline:
          "border-input bg-transparent hover:bg-ui-list-hover aria-expanded:bg-ui-list-hover",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost: "hover:bg-ui-list-hover aria-expanded:bg-ui-list-hover",
        destructive: "bg-ui-error text-white hover:bg-ui-error/90",
        link: "text-ui-link underline-offset-2 hover:underline",
      },
      // Slack 컨트롤은 넉넉하다 — 기본 32px, 위아래로 한 단계씩.
      size: {
        default:
          "h-8 gap-2 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 gap-1 px-2 text-[13px] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-7 gap-1.5 px-2.5 text-[13px] has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        lg: "h-9 gap-2 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-8",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-7",
        "icon-lg": "size-9 [&_svg:not([class*='size-'])]:size-[18px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

// buttonVariants 는 이 파일 안에서만 쓰므로 export 하지 않는다
// (컴포넌트 파일이 컴포넌트 외의 값을 export 하면 fast refresh 가 깨진다).
export { Button }
