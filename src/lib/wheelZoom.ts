export function attachWheelZoom(host: HTMLElement): () => void {
  const forwardZoomWheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return
    if (!(event.target instanceof HTMLCanvasElement)) return
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
