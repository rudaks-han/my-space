import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/*
 * Slack 배지: 20px 높이의 알약(rounded-full), 11px/bold 글자.
 * 개수 배지·칩은 Slack 에서 모두 알약이므로 원형을 기본값으로 둔다.
 */
const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 text-[11px] font-bold whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-ui-badge text-ui-badge-fg [a]:hover:bg-ui-badge/90",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive: "bg-ui-error text-white [a]:hover:bg-ui-error/90",
        outline:
          "border-border text-foreground [a]:hover:bg-ui-list-hover [a]:hover:text-foreground",
        ghost: "hover:bg-ui-list-hover hover:text-foreground",
        link: "text-ui-link underline-offset-2 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

// badgeVariants 는 이 파일 안에서만 쓰므로 export 하지 않는다
// (컴포넌트 파일이 컴포넌트 외의 값을 export 하면 fast refresh 가 깨진다).
export { Badge }
