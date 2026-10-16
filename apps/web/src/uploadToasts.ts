// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Envois de pieces jointes -> notifications. Une ligne par fichier : barre de
// progression pendant l'envoi (mesuree en mode serveur, « en cours » en pair a
// pair), puis succes ou erreur avec le nom du fichier et la raison.
import { notifyProgress, type ProgressToast } from '@savoire/notifications'
import { subscribeUploads, type UploadEvent } from '@savoire/platform'

type Subscribe = (cb: (event: UploadEvent) => void) => () => void

/** Branche le suivi des envois sur les notifications. Rend la fonction de debranchement. */
export function showUploadsAsToasts(subscribe: Subscribe = subscribeUploads): () => void {
  const open = new Map<number, ProgressToast>()
  return subscribe(event => {
    let toast = open.get(event.uploadId)
    if (!toast) {
      toast = notifyProgress('Envoi de l\'image…', event.fileName)
      open.set(event.uploadId, toast)
    }
    if (event.kind === 'progress') {
      toast.update(event.fraction)
    } else if (event.kind === 'done') {
      open.delete(event.uploadId)
      toast.succeed('Image envoyée', `${event.fileName} → ${folderLabel(event.path)}`)
    } else {
      open.delete(event.uploadId)
      toast.fail('Échec de l\'envoi', `${event.fileName} : ${event.reason}`)
    }
  })
}

/** « rangée dans Dossier/Ma note/ » : ou l'image a ete rangee. */
function folderLabel(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? 'à la racine du vault' : `rangée dans ${path.slice(0, slash + 1)}`
}
