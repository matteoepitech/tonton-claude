// A right-click menu in the site's look (Radix's context menu, styled like the dropdown menu), and the actions it and a
// dropdown share: each list of actions is written once and shows in both.
import type { LucideIcon } from 'lucide-react'
import { ContextMenu as ContextPrimitive } from 'radix-ui'
import type { ReactNode } from 'react'
import { cn } from './cn'
import { MenuItem, MenuSeparator } from './menu'

/** One entry of a menu; null draws a separator. */
export type Action = {
  label: string
  icon?: LucideIcon
  onSelect: () => void
  destructive?: boolean
  disabled?: boolean
} | null

const item =
  'relative flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none select-none focus:bg-accent data-[disabled]:opacity-50 [&_svg]:size-4'

/** What it wraps opens the menu on a right-click (or a long press), instead of the browser's own. */
export function ContextMenu({ actions, children }: { actions: Action[]; children: ReactNode }) {
  const shown = trim(actions)
  if (!shown.length) return children
  return (
    <ContextPrimitive.Root>
      <ContextPrimitive.Trigger asChild>{children}</ContextPrimitive.Trigger>
      <ContextPrimitive.Portal>
        <ContextPrimitive.Content className="z-50 min-w-[11rem] overflow-hidden rounded-xl border bg-popover/95 p-1 text-popover-foreground shadow-lg backdrop-blur">
          {shown.map((action, index) =>
            action ? (
              <ContextPrimitive.Item
                // biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed for one render.
                key={index}
                disabled={action.disabled}
                onSelect={action.onSelect}
                className={cn(item, action.destructive && 'text-destructive')}
              >
                {action.icon && <action.icon />}
                {action.label}
              </ContextPrimitive.Item>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed for one render.
              <ContextPrimitive.Separator key={index} className="-mx-1 my-1 h-px bg-border" />
            ),
          )}
        </ContextPrimitive.Content>
      </ContextPrimitive.Portal>
    </ContextPrimitive.Root>
  )
}

/** The same actions as the items of a dropdown menu (`MenuContent`). */
export function MenuActions({ actions }: { actions: Action[] }) {
  return trim(actions).map((action, index) =>
    action ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed for one render.
      <MenuItem key={index} disabled={action.disabled} onSelect={action.onSelect} variant={action.destructive ? 'destructive' : undefined}>
        {action.icon && <action.icon />}
        {action.label}
      </MenuItem>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed for one render.
      <MenuSeparator key={index} />
    ),
  )
}

/** No separator first, last or twice in a row. */
function trim(actions: Action[]): Action[] {
  const kept: Action[] = []
  for (const action of actions) if (action || kept.at(-1)) kept.push(action)
  while (kept.length && !kept.at(-1)) kept.pop()
  return kept
}
