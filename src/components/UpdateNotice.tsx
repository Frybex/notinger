import { useEffect, useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { relaunch } from '@tauri-apps/plugin-process'
import { check, type Update } from '@tauri-apps/plugin-updater'
import Icon from './Icon'

type Status = 'available' | 'downloading' | 'installing'

type UpdateNoticeProps = {
  /** Enregistre le travail en cours avant le redémarrage. */
  onBeforeInstall: () => Promise<unknown>
  onError: (message: string) => void
}

const CHECK_DELAY_MS = 4000

/**
 * Vérifie discrètement les mises à jour au démarrage (latest.json publié sur
 * Frybex/notinger-releases) et propose de les installer en un clic.
 */
export default function UpdateNotice({ onBeforeInstall, onError }: UpdateNoticeProps) {
  const [update, setUpdate] = useState<Update | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [status, setStatus] = useState<Status>('available')
  const [progress, setProgress] = useState<number | null>(null)

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void check()
        .then((found) => {
          if (!cancelled && found) setUpdate(found)
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

  const install = async () => {
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
  }

  if (!update || dismissed) return null

  return (
    <div className="update-notice" role="status">
      <span className="update-icon">
        <Icon name="download" size={15} />
      </span>
      <div className="update-copy">
        <strong>Notinger {update.version} est disponible</strong>
        <span>
          {status === 'available'
            ? 'Tes fichiers et dossiers restent en place.'
            : status === 'downloading'
              ? progress !== null
                ? `Téléchargement… ${progress} %`
                : 'Téléchargement…'
              : 'Installation en cours — redémarrage automatique…'}
        </span>
      </div>
      {status === 'available' ? (
        <>
          <button type="button" className="primary" onClick={() => void install()}>
            Installer
          </button>
          <button
            type="button"
            className="ghost icon-only"
            title="Plus tard"
            onClick={() => setDismissed(true)}
          >
            <Icon name="x" size={13} />
          </button>
        </>
      ) : null}
    </div>
  )
}
