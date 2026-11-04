// Cuts text to a length without splitting a character in two. Half a surrogate pair (an emoji cut after its first code
// unit) goes out of JSON.stringify as an escape like `\ud83c`, which Swift's JSONDecoder refuses with the whole blob.

/** At most `max` UTF-16 code units of `text`: one fewer when the last one kept would be the first half of a pair. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text
  const end = max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max
  return text.slice(0, end)
}

/** At most the last `max` UTF-16 code units of `text`: one fewer when the first one kept would be the second half of a pair. */
export function cutTextEnd(text: string, max: number): string {
  if (text.length <= max) return text
  const start = text.length - max
  return text.slice(max > 0 && isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start)
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff
