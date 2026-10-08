import type { Update } from '@tauri-apps/plugin-updater'
import Icon from './Icon'
import type { UpdaterStatus } from '../lib/useUpdater'

type UpdateNoticeProps = {
  update: Update | null
  dismissed: boolean
  status: UpdaterStatus
  progress: number | null
  onInstall: () => void
  onDismiss: () => void
}

/** Bandeau de mise à jour : la logique vit dans `useUpdater`, ici l'affichage. */
export default function UpdateNotice({
  update,
  dismissed,
  status,
  progress,
  onInstall,
  onDismiss
}: UpdateNoticeProps) {
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
          <button type="button" className="primary" onClick={onInstall}>
            Installer
          </button>
          <button
            type="button"
            className="ghost icon-only"
            title="Plus tard"
            onClick={onDismiss}
          >
            <Icon name="x" size={13} />
          </button>
        </>
      ) : null}
    </div>
  )
}
