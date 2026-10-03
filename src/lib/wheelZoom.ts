const WHEEL_TICK = 120
const BURST_GAP_MS = 80

type WheelDevice = 'mouse' | 'trackpad'

let nativeWheelDevice: WheelDevice | null = null

export function setWheelDevice(device: WheelDevice | null) {
  nativeWheelDevice = device
}

type LegacyWheelEvent = WheelEvent & {
  wheelDeltaX?: number
  wheelDeltaY?: number
}

function looksLikeMouseWheel(event: WheelEvent): boolean {
  if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
    return true
  }
  const legacy = event as LegacyWheelEvent
  const tick = legacy.wheelDeltaY || legacy.wheelDeltaX || 0
  if (tick !== 0) {
    return Math.abs(tick) % WHEEL_TICK === 0
  }
  return (
    (event.deltaX === 0) !== (event.deltaY === 0) &&
    Math.abs(event.deltaY || event.deltaX) >= 40
  )
}

export function attachWheelZoom(host: HTMLElement): () => void {
  let lastWheelAt = Number.NEGATIVE_INFINITY
  let burstIsMouse = false

  const forwardZoomWheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return
    if (!(event.target instanceof HTMLCanvasElement)) return

    const now = performance.now()
    const mouseLike =
      nativeWheelDevice !== null ? nativeWheelDevice === 'mouse' : looksLikeMouseWheel(event)
    if (now - lastWheelAt > BURST_GAP_MS) {
      burstIsMouse = mouseLike
    } else if (!mouseLike) {
      burstIsMouse = false
    }
    lastWheelAt = now

    if (!burstIsMouse || event.deltaY === 0) return

    event.preventDefault()
    event.stopPropagation()
    event.target.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaZ: event.deltaZ,
        deltaMode: event.deltaMode,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY
      })
    )
  }

  host.addEventListener('wheel', forwardZoomWheel, { capture: true, passive: false })
  return () => host.removeEventListener('wheel', forwardZoomWheel, { capture: true })
}
