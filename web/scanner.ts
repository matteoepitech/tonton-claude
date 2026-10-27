// Signs in with the camera: reads the QR code of the Mac app (Settings › Machines › Phone or browser), which holds the
// recovery key, instead of typing it. Frames are decoded in the page with jsQR, since Safari, Firefox and Chrome on
// Windows and Linux have no BarcodeDetector. Nothing is kept: no frame leaves the page or stays after it is read, and the
// camera stops as soon as a code is used, the scan is cancelled or the page is hidden.

import jsQR from 'jsqr'

/** Frames are scaled down to this longest side: enough for a code filling part of the view, and quick on a phone. */
const MAX_SIDE = 720
/** Between two frames: a code is read within a few of them, and the phone stays cool. */
const FRAME_MS = 150

export interface Frame {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** The text of the QR code in the frame, or null. The app shows its code dark on white, so frames are not inverted. */
export function readCode(frame: Frame): string | null {
  return jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' })?.data || null
}

/** The size a camera frame is read at. */
export function frameSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height, 1))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** Why the camera did not start, as the user can act on it. */
export function cameraProblem(error: unknown): string {
  const name = error instanceof Error || error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'The camera is not allowed for this page. Allow it, or paste the key.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'This device has no camera to scan with. Paste the key.'
  return 'The camera did not start. Paste the key instead.'
}

/** Browsers only give the camera to pages served over https, from localhost or from a file. */
export const canScan = (): boolean => typeof navigator.mediaDevices?.getUserMedia === 'function'

export interface Scan {
  stop(): void
}

/**
 * Shows the back camera in the video and reads its frames until `onCode` takes a code (returns true). Throws when the
 * camera does not start; `cameraProblem` says why.
 */
export async function startScan(video: HTMLVideoElement, onCode: (text: string) => boolean): Promise<Scan> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    clearTimeout(timer)
    for (const track of stream.getTracks()) track.stop()
    video.srcObject = null
    document.removeEventListener('visibilitychange', hidden)
  }
  const hidden = () => {
    if (document.hidden) stop()
  }
  document.addEventListener('visibilitychange', hidden)
  // iOS plays a camera inline, without its fullscreen player, only for a muted inline video.
  video.muted = true
  video.playsInline = true
  video.srcObject = stream
  await video.play().catch(() => {})

  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  const tick = () => {
    if (stopped) return
    if (context && video.videoWidth > 0) {
      const { width, height } = frameSize(video.videoWidth, video.videoHeight)
      canvas.width = width
      canvas.height = height
      context.drawImage(video, 0, 0, width, height)
      const text = readCode(context.getImageData(0, 0, width, height))
      if (text && onCode(text)) return stop()
    }
    timer = setTimeout(tick, FRAME_MS)
  }
  tick()
  return { stop }
}
