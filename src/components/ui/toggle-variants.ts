import { cva } from "class-variance-authority"

/*
 * Slack 필터 토글 톤: 8px 라운드, 15px/semibold, 32px 기본 높이.
 * hover 는 옅은 리스트 호버색만, 켜진 상태는 와인색 선택 알약(--ui-list-active) + 흰 굵은 글자다
 * — 사이드바 활성 행과 같은 위계를 쓴다.
 *
 * toggle.tsx 와 toggle-group.tsx 가 함께 쓰므로 별도 모듈에 둔다
 * (컴포넌트 파일이 컴포넌트 외의 값을 export 하면 fast refresh 가 깨진다).
 */
export const toggleVariants = cva(
  "group/toggle inline-flex items-center justify-center gap-1.5 rounded-lg text-[15px] font-semibold whitespace-nowrap transition-colors outline-none hover:bg-ui-list-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-pressed:bg-ui-list-active aria-pressed:font-bold aria-pressed:text-ui-list-active-fg data-[state=on]:bg-ui-list-active data-[state=on]:font-bold data-[state=on]:text-ui-list-active-fg [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border border-input bg-transparent hover:bg-ui-list-hover",
      },
      size: {
        default:
          "h-8 min-w-8 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        sm: "h-7 min-w-7 px-2 text-[13px] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5",
        lg: "h-9 min-w-9 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)
