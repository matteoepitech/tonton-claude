import { describe, expect, test } from 'bun:test'
import { cutText } from '../text'

describe('cutText', () => {
  test('keeps short text as it is', () => {
    expect(cutText('Déployé 🎉', 20)).toBe('Déployé 🎉')
    expect(cutText('🎉', 2)).toBe('🎉')
  })

  test('cuts before an emoji that would be split, after one that fits', () => {
    expect(cutText('ab🎉cd', 3)).toBe('ab')
    expect(cutText('ab🎉cd', 4)).toBe('ab🎉')
    expect(cutText('abcdef', 3)).toBe('abc')
    expect(cutText('🎉🎉', 1)).toBe('')
  })
})
