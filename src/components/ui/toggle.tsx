import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { type VariantProps } from "class-variance-authority"

import { toggleVariants } from "@/components/ui/toggle-variants"
import { cn } from "@/lib/utils"

/** 단독 토글. 모양은 전부 toggleVariants(Slack 필터 토글 톤)에서 온다. */
function Toggle({
  className,
  variant = "default",
  size = "default",
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle }
