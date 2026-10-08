import { useCallback, useEffect, useRef, useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { relaunch } from '@tauri-apps/plugin-process'
import { check, type Update } from '@tauri-apps/plugin-updater'

export type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'installing'

type UseUpdaterOptions = {
  /** Enregistre le travail en cours avant le redémarrage. */
  onBeforeInstall: () => Promise<unknown>
  onError: (message: string) => void
}

const CHECK_DELAY_MS = 4000
const UP_TO_DATE_MS = 4000
const RECHECK_MS = 6 * 60 * 60 * 1000

/**
 * Mises à jour via latest.json publié sur Frybex/notinger : vérification
 * discrète au démarrage, vérification manuelle à la demande, installation
 * en un clic avec enregistrement préalable.
 */
export function useUpdater({ onBeforeInstall, onError }: UseUpdaterOptions) {
  const [update, setUpdate] = useState<Update | null>(null)
  const [status, setStatus] = useState<UpdaterStatus>('idle')
  const [progress, setProgress] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const statusRef = useRef<UpdaterStatus>('idle')
  const dismissedRef = useRef(false)

  useEffect(() => {
    statusRef.current = status
  }, [status])

  useEffect(() => {
    dismissedRef.current = dismissed
  }, [dismissed])

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void check()
        .then((found) => {
          if (!cancelled && found) {
            setUpdate(found)
            setStatus('available')
          }
        })
        .catch(() => {
          // Hors ligne ou service injoignable : nouvel essai au prochain lancement.
        })
    }, CHECK_DELAY_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])

  // Revérification périodique : rattrape un check manqué au démarrage
  // (hors ligne, veille au lancement). Un renvoi explicite (« Plus tard »)
  // est respecté jusqu'au prochain redémarrage.
  useEffect(() => {
    if (!isTauri()) return
    const timer = window.setInterval(() => {
      const current = statusRef.current
      if (
        current === 'checking' ||
        current === 'downloading' ||
        current === 'installing' ||
        dismissedRef.current
      ) {
        return
      }
      void check()
        .then((found) => {
          if (found) {
            setUpdate(found)
            setStatus('available')
          }
        })
        .catch(() => {
          // Silencieux : nouvel essai au prochain passage.
        })
    }, RECHECK_MS)
    return () => window.clearInterval(timer)
  }, [])

  // Le « À jour » est transitoire : retour au repos après quelques secondes.
  useEffect(() => {
    if (status !== 'up-to-date') return
    const timer = window.setTimeout(() => setStatus('idle'), UP_TO_DATE_MS)
    return () => window.clearTimeout(timer)
  }, [status])

  const checkNow = useCallback(async () => {
    if (!isTauri()) return
    const current = statusRef.current
    if (current === 'checking' || current === 'downloading' || current === 'installing') return
    setStatus('checking')
    try {
      const found = await check()
      if (found) {
        setUpdate(found)
        setDismissed(false)
        setStatus('available')
      } else {
        setStatus('up-to-date')
      }
    } catch (cause) {
      setStatus('idle')
      onError(`Vérification impossible : ${String(cause)}`)
    }
  }, [onError])

  const install = useCallback(async () => {
    if (!update) return
    setStatus('downloading')
    setProgress(null)
    try {
      await onBeforeInstall()
    } catch {
      // Un souci d'enregistrement ne doit pas bloquer la mise à jour.
    }
    try {
      let total = 0
      let received = 0
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength
          if (total > 0) {
            setProgress(Math.min(100, Math.round((received / total) * 100)))
          }
        } else if (event.event === 'Finished') {
          setStatus('installing')
        }
      })
      await relaunch()
    } catch (cause) {
      setStatus('available')
      setProgress(null)
      onError(`Mise à jour impossible : ${String(cause)}`)
    }
  }, [update, onBeforeInstall, onError])

  const dismiss = useCallback(() => setDismissed(true), [])

  return { update, status, progress, dismissed, dismiss, checkNow, install }
}
