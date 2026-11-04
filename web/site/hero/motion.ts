// Tonton's clock and the reader's motion setting. With reduced motion he holds his first frame and nothing floats.
import { useEffect, useState } from 'react'
import { type HeroPose, poseInterval } from '../../hero'

const QUERY = '(prefers-reduced-motion: reduce)'

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia(QUERY).matches)
  useEffect(() => {
    const media = window.matchMedia(QUERY)
    const update = () => setReduced(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return reduced
}

/** floor(now / the pose's frame time), as the notch counts it, so every client shows the same frame; 0 when still. */
export function usePoseTick(pose: HeroPose, moving: boolean): number {
  const ms = poseInterval(pose)
  const [tick, setTick] = useState(() => (moving ? Math.floor(Date.now() / ms) : 0))
  useEffect(() => {
    if (!moving) {
      setTick(0)
      return
    }
    setTick(Math.floor(Date.now() / ms))
    const timer = setInterval(() => setTick(Math.floor(Date.now() / ms)), ms)
    return () => clearInterval(timer)
  }, [ms, moving])
  return tick
}
