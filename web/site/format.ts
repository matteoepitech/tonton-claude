// Times, counts and durations as the site writes them.

export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`
  return new Date(iso).toLocaleDateString()
}

export function compact(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1000) return `${Math.round(count / 1000)}k`
  return String(count)
}

export function duration(seconds: number): string {
  if (seconds < 60) return seconds ? `${Math.round(seconds)} s` : '—'
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
}

export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

/** `2026-10-28T18:00` in local time, as a datetime-local input takes it. */
export function localInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
