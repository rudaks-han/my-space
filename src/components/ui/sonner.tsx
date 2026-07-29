"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "lucide-react"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          // Slack 알림 토스트: 위젯 배경 + 위젯 테두리, 패널과 같은 10px 라운드.
          "--normal-bg": "var(--ui-widget)",
          "--normal-text": "var(--foreground)",
          "--normal-border": "var(--ui-widget-border)",
          "--border-radius": "10px",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          // 떠 있는 오버레이이므로 그림자는 오버레이 단계(0_4px_16px)로 준다.
          toast: "cn-toast text-[15px] shadow-[0_4px_16px_rgba(0,0,0,0.16)]",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
