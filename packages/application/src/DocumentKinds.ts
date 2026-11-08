// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La nature d'un document (CRDT ou instantane) est enregistree avec lui, dans
// le repertoire du vault. Un document cree aujourd'hui la recoit a sa
// creation (VaultClient.createFile). Pour les documents plus anciens, ce
// module la recopie depuis le type declare par leur plugin, quand ce plugin
// est la : ensuite, un membre sans le plugin relit le document correctement.
//
// Seuls les CRDT autres que le Markdown en ont besoin : sans plugin, un
// document se lit comme un instantane, ce qui est deja juste pour un
// instantane. Les pieces jointes sont des fichiers, pas des documents.
import { isAttachmentPath, type DocumentSyncKind, type IVaultDirectory } from '@savoire/platform'

/**
 * Enregistre la nature des documents qui n'en ont pas, quand leur type est
 * connu. `kindOfType` rend undefined pour un type inconnu (plugin absent) :
 * le document est laisse tel quel. Rend le nombre de documents completes.
 */
export function recordDocumentKinds(
  directory: Pick<IVaultDirectory, 'getAll' | 'setKind'>,
  kindOfType: (path: string) => DocumentSyncKind | undefined,
): number {
  if (!directory.setKind) return 0
  let n = 0
  for (const doc of directory.getAll()) {
    if (doc.kind || doc.path.toLowerCase().endsWith('.md') || isAttachmentPath(doc.path)) continue
    if (kindOfType(doc.path) !== 'crdt') continue
    directory.setKind(doc.id, 'crdt')
    n++
  }
  return n
}

/**
 * Complete les natures manquantes au fil des changements du repertoire (un
 * plugin qui arrive, un document recu d'un autre membre). Regroupe : un passage
 * apres `delayMs` de calme. `canWrite` : un lecteur ne modifie pas le repertoire.
 */
export function watchDocumentKinds(
  directory: Pick<IVaultDirectory, 'getAll' | 'setKind' | 'onChange'>,
  kindOfType: (path: string) => DocumentSyncKind | undefined,
  canWrite: () => boolean,
  delayMs = 1500,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const run = (): void => {
    timer = null
    if (stopped || !canWrite()) return
    try { recordDocumentKinds(directory, kindOfType) } catch (err) { console.warn('[natures] enregistrement impossible', err) }
  }
  const schedule = (): void => {
    if (stopped || timer) return
    timer = setTimeout(run, delayMs)
  }
  const off = directory.onChange(schedule)
  schedule()
  return () => {
    stopped = true
    off()
    if (timer) clearTimeout(timer)
  }
}
