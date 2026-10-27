// Where the island sits: centered at the top of the work area, the part of the screen that taskbars and top bars leave,
// so it hangs from the top edge on Windows and from the top bar on GNOME. Its window is exactly the size of what shows.

import type { IslandMode } from '../bridge'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const ISLAND_SIZES: Record<IslandMode, { width: number; height: number }> = {
  collapsed: { width: 380, height: 40 },
  expanded: { width: 540, height: 660 },
}

/** Kept free on the sides and at the bottom of small screens. */
const MARGIN = 12

export function islandBounds(area: Rect, mode: IslandMode): Rect {
  const size = ISLAND_SIZES[mode]
  const width = Math.max(1, Math.min(size.width, area.width - 2 * MARGIN))
  const height = Math.max(1, Math.min(size.height, area.height - MARGIN))
  return { x: Math.round(area.x + (area.width - width) / 2), y: area.y, width, height }
}
