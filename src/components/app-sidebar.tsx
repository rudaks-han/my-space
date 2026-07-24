import * as React from "react"
import { LayoutGridIcon, SettingsIcon } from "lucide-react"

import { useMenuOrder } from "@/lib/use-menu-order"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  activeId: string
  onSelectMenu: (id: string) => void
}

export function AppSidebar({
  activeId,
  onSelectMenu,
  ...props
}: AppSidebarProps) {
  const { groups, moveItem } = useMenuOrder()

  // 드래그 중인 항목과 그룹, 드롭 대상 표시용 상태. groupId 로 같은 그룹 안에서만 재정렬.
  const [dragId, setDragId] = React.useState<string | null>(null)
  const [dragGroup, setDragGroup] = React.useState<string | null>(null)
  const [overId, setOverId] = React.useState<string | null>(null)

  const endDrag = () => {
    setDragId(null)
    setDragGroup(null)
    setOverId(null)
  }

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton className="data-[slot=sidebar-menu-button]:p-1.5!">
              <LayoutGridIcon className="size-5!" />
              <span className="text-base font-semibold">My Space</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {groups.map((group) => (
          <SidebarGroup key={group.id}>
            {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((m) => {
                  const Icon = m.icon
                  const isDragging = dragId === m.id
                  const isOver =
                    overId === m.id && dragGroup === group.id && !isDragging
                  return (
                    <SidebarMenuItem
                      key={m.id}
                      draggable
                      onDragStart={(e) => {
                        setDragId(m.id)
                        setDragGroup(group.id)
                        e.dataTransfer.effectAllowed = "move"
                      }}
                      onDragOver={(e) => {
                        // 같은 그룹의 항목 위에서만 드롭 허용.
                        if (dragGroup !== group.id || dragId === m.id) return
                        e.preventDefault()
                        e.dataTransfer.dropEffect = "move"
                        setOverId(m.id)
                      }}
                      onDrop={(e) => {
                        if (dragGroup !== group.id || !dragId) return
                        e.preventDefault()
                        moveItem(group.id, dragId, m.id)
                        endDrag()
                      }}
                      onDragEnd={endDrag}
                      className={cn(
                        "rounded-md transition-opacity",
                        isDragging && "opacity-40",
                        isOver &&
                          "before:bg-primary relative before:absolute before:-top-0.5 before:right-1 before:left-1 before:h-0.5 before:rounded-full",
                      )}
                    >
                      <SidebarMenuButton
                        tooltip={m.title}
                        isActive={activeId === m.id}
                        onClick={() => onSelectMenu(m.id)}
                        className="cursor-pointer"
                      >
                        <Icon />
                        <span>{m.title}</span>
                      </SidebarMenuButton>
                      {m.badge}
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-muted-foreground text-xs">v0.1.0</span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="설정"
                  onClick={() => onSelectMenu("settings")}
                  className={cn(
                    "cursor-pointer",
                    activeId === "settings" && "bg-muted text-foreground",
                  )}
                >
                  <SettingsIcon />
                </Button>
              }
            />
            <TooltipContent>설정</TooltipContent>
          </Tooltip>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
