// The web app reads the QR code the Mac app draws: swift-qr.json is one made by app/Sources/TontonCore/QRCode.swift.
import { describe, expect, test } from 'bun:test'
import { parseRecoveryKey } from '../../shared/recovery-key'
import { cameraProblem, type Frame, frameSize, readCode } from '../scanner'
import vector from './swift-qr.json'

/** The code drawn dark on white, `scale` pixels per module, at `left`, `top` of a gray frame, like a camera sees a screen. */
function frame(rows: string[], options: { scale: number; width: number; height: number; left: number; top: number }): Frame {
  const { scale, width, height, left, top } = options
  const data = new Uint8ClampedArray(width * height * 4).fill(96)
  const quiet = 4 * scale
  const side = rows.length * scale + 2 * quiet
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const module = rows[Math.floor((y - quiet) / scale)]?.[Math.floor((x - quiet) / scale)]
      const value = module === '1' ? 20 : 235
      const at = ((top + y) * width + left + x) * 4
      data[at] = data[at + 1] = data[at + 2] = value
      data[at + 3] = 255
    }
  }
  for (let at = 3; at < data.length; at += 4) data[at] = 255
  return { data, width, height }
}

describe('scanning the Mac app’s QR code', () => {
  test('reads the recovery key it holds, which signs the web app in', () => {
    const text = readCode(frame(vector.rows, { scale: 4, width: 400, height: 400, left: 26, top: 26 }))
    expect(text).toBe(vector.text)
    expect(parseRecoveryKey(text ?? '')?.relay).toBe('https://relay.example.com')
  })

  test('reads it small and off-center in a larger frame, as a camera gives it', () => {
    const size = frameSize(1280, 720)
    expect(readCode(frame(vector.rows, { scale: 3, ...size, left: 300, top: 180 }))).toBe(vector.text)
  })

  test('finds nothing where there is no code', () => {
    expect(readCode({ data: new Uint8ClampedArray(64 * 48 * 4).fill(255), width: 64, height: 48 })).toBeNull()
  })

  test('scales camera frames down to a size phones read quickly', () => {
    expect(frameSize(1920, 1080)).toEqual({ width: 720, height: 405 })
    expect(frameSize(1080, 1920)).toEqual({ width: 405, height: 720 })
    expect(frameSize(640, 480)).toEqual({ width: 640, height: 480 })
    expect(frameSize(0, 0)).toEqual({ width: 1, height: 1 })
  })

  test('says what to do when the camera does not start', () => {
    expect(cameraProblem(new DOMException('denied', 'NotAllowedError'))).toContain('not allowed')
    expect(cameraProblem(new DOMException('none', 'NotFoundError'))).toContain('no camera')
    expect(cameraProblem('odd')).toContain('did not start')
  })
})
