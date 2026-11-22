// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// « Copier le lien vers ce bloc » : le bloc sous le curseur recoit un
// identifiant « ^id » s'il n'en a pas, et son lien [[Note#^id]] part dans le
// presse-papiers (a coller dans une autre note, ou ![[...]] pour l'integrer).
import { blockAt, blockIdInsertion, linkTargetFor, newBlockId, splitNoteBlocks, type VaultAPI } from '@savoire/plugin-api'
import { notify } from '@savoire/notifications'
import { liveBlocks } from './liveBlocks'

/** Le texte avec « ^id » au bloc de cette empreinte (inchange si le bloc a bouge ou a deja un id). */
export function addBlockId(text: string, hash: string, id: string): string {
  const block = splitNoteBlocks(text).find(b => b.hash === hash)
  if (!block || block.blockId) return text
  const { at, insert } = blockIdInsertion(block, id)
  return text.slice(0, at) + insert + text.slice(at)
}

export async function copyBlockLink(vault: VaultAPI, selection: { from: number } | undefined): Promise<void> {
  const snap = liveBlocks.current()
  const block = snap && selection ? blockAt(snap.blocks, selection.from) : null
  if (!snap || !block || block.kind === 'frontmatter') {
    notify('info', 'Placez le curseur dans un paragraphe', 'Le lien vise le bloc sous le curseur.')
    return
  }
  let id = block.blockId
  if (!id) {
    if (typeof vault.editText !== 'function') { notify('danger', 'Lien impossible', 'Cette note ne peut pas être modifiée ici.'); return }
    id = newBlockId(snap.blocks.flatMap(b => (b.blockId ? [b.blockId] : [])))
    const chosen = id
    const ok = await vault.editText(snap.docId, text => addBlockId(text, block.hash, chosen)).catch(() => false)
    if (!ok) { notify('danger', 'Lien impossible', 'Le bloc a changé entre-temps : réessayez.'); return }
  }
  const paths = (vault.getFileTree?.() ?? []).map(e => e.path)
  const target = linkTargetFor(snap.path, paths.length ? paths : [snap.path])
  const link = `[[${target}#^${id}]]`
  try {
    await navigator.clipboard.writeText(link)
    notify('success', 'Lien copié', link)
  } catch {
    notify('info', 'Lien du bloc', link)
  }
}
