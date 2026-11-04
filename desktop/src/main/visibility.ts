// What the tray icon, the menu and opening the app again do to the island. Only the menu's Hide item and Alt+F4 hide it:
// a click on the tray icon while the bar shows opens the island instead of making it vanish, and opening the app again
// always brings it back open, the way back on a desktop without a tray.

import type { IslandMode } from '../bridge'

/** The tray icon's left click, the menu's Show or Hide item, or the app opened a second time. */
export type Trigger = 'tray' | 'menu' | 'launch'

/** Show the hidden island open, open its bar, take the keyboard, close it to its bar, or hide it. */
export type Step = 'show' | 'expand' | 'focus' | 'collapse' | 'hide'

export function nextStep(trigger: Trigger, visible: boolean, mode: IslandMode): Step {
  if (!visible) return 'show'
  if (trigger === 'menu') return 'hide'
  if (mode === 'collapsed') return 'expand'
  // Open already: the tray icon closes it to its bar, like a click on the bar; opening the app again brings it forward.
  return trigger === 'tray' ? 'collapse' : 'focus'
}
