// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Images dans Plume, comme Obsidian. UN SEUL chemin pour coller (Ctrl+V),
// deposer (glisser) et le bouton Image : le fichier part par l'envoyeur que
// fournit l'hote (le vault, quel que soit le profil de synchro), puis
// `![[Nom.png]]` est insere, chacun sur sa ligne pour etre rendu en image.
//
// L'editeur ne stocke rien lui-meme : il ne connait que l'envoyeur. Le
// nommage dans `attachments/` et les collisions sont l'affaire du vault.

import { EditorView } from '@codemirror/view'
import { Facet, StateEffect, StateField, type Extension, type Text } from '@codemirror/state'

/** Envoie un fichier et rend le texte du lien (`Nom.png`, ou le chemin si le nom est ambigu). */
export type ImageUploader = (file: File) => Promise<string>

/** L'envoyeur de l'editeur. Absent : pas d'envoi possible (lecture seule, bac a sable). */
export const imageUploader = Facet.define<ImageUploader, ImageUploader | null>({
  combine: values => values[0] ?? null,
})

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'])

export function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true
  return IMAGE_EXTS.has(file.name.split('.').at(-1)?.toLowerCase() ?? '')
}

/** Nom d'une image collee : « Pasted image AAAAMMJJHHmmss.png ». */
export function pastedImageName(date: Date, ext = 'png'): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  return `Pasted image ${stamp}.${ext}`
}

/** Extension d'une image d'apres son type MIME (« image/jpeg » -> « jpg »). */
export function imageExtensionOf(mime: string): string {
  const sub = mime.split('/')[1]?.split('+')[0]?.toLowerCase() ?? ''
  if (sub === 'jpeg') return 'jpg'
  return sub || 'png'
}

/**
 * Texte a inserer a `pos` pour ces liens. Chaque image a sa propre ligne
 * (sinon elle ne serait pas rendue) : on coupe la ligne si besoin, et le
 * curseur se pose apres, pour que l'image s'affiche tout de suite.
 */
export function imageInsertion(doc: Text, pos: number, targets: readonly string[]): { from: number; insert: string; cursor: number } | null {
  if (targets.length === 0) return null
  const at = Math.max(0, Math.min(pos, doc.length))
  const line = doc.lineAt(at)
  const before = line.text.slice(0, at - line.from)
  const insert = (before.trim() ? '\n' : '') + targets.map(t => `![[${t}]]`).join('\n') + '\n'
  return { from: at, insert, cursor: at + insert.length }
}

// ── Point d'insertion suivi pendant l'envoi ──────────────────────────────────
// L'envoi prend du temps ; pendant ce temps, on tape, les autres pairs aussi.
// Le point de depot suit ces changements, comme une position du document.

const addPending = StateEffect.define<{ id: number; pos: number }>()
const dropPending = StateEffect.define<number>()

const pendingInsertions = StateField.define<ReadonlyMap<number, number>>({
  create: () => new Map(),
  update(map, tr) {
    let next = map
    if (tr.docChanged && map.size > 0) {
      const mapped = new Map<number, number>()
      for (const [id, pos] of map) mapped.set(id, tr.changes.mapPos(pos, -1))
      next = mapped
    }
    for (const e of tr.effects) {
      if (e.is(addPending)) next = new Map(next).set(e.value.id, e.value.pos)
      else if (e.is(dropPending)) { const m = new Map(next); m.delete(e.value); next = m }
    }
    return next
  },
})

let nextInsertionId = 0

/**
 * Envoie les images et insere leurs liens a `pos`. `pasted` : images du
 * presse-papiers, renommees « Pasted image ... » comme dans Obsidian.
 * Rend false si rien n'est a faire (pas d'envoyeur, pas d'image).
 */
export async function insertImageFiles(view: EditorView, files: readonly File[], pos: number, pasted = false): Promise<boolean> {
  const upload = view.state.facet(imageUploader)
  const images = files.filter(isImageFile)
  if (!upload || images.length === 0 || view.state.readOnly) return false

  const id = ++nextInsertionId
  view.dispatch({ effects: addPending.of({ id, pos }) })
  const targets: string[] = []
  for (const file of images) {
    const named = pasted
      ? new File([file], pastedImageName(new Date(), imageExtensionOf(file.type)), { type: file.type })
      : file
    try {
      targets.push(await upload(named))
    } catch (err) {
      console.error('[Plume] envoi de l\'image impossible', err)
    }
  }

  try {
    const at = view.state.field(pendingInsertions, false)?.get(id) ?? pos
    const spec = imageInsertion(view.state.doc, at, targets)
    view.dispatch({
      changes: spec ? { from: spec.from, insert: spec.insert } : undefined,
      selection: spec ? { anchor: spec.cursor } : undefined,
      effects: dropPending.of(id),
      userEvent: 'input.paste',
    })
  } catch (err) {
    // L'editeur a ete ferme pendant l'envoi : l'image est dans le vault, sans lien.
    console.warn('[Plume] editeur ferme avant l\'insertion de l\'image', err)
  }
  return targets.length > 0
}

/**
 * Bouton et commande « Image » : choisir des fichiers, puis le meme chemin
 * que coller/deposer. Sans envoyeur, insere un lien `![[]]` a remplir.
 */
export function pickAndInsertImages(view: EditorView): void {
  if (!view.state.facet(imageUploader) || typeof document === 'undefined') {
    const { from, to } = view.state.selection.main
    view.dispatch({ changes: { from, to, insert: '![[]]' }, selection: { anchor: from + 3 } })
    view.focus()
    return
  }
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.multiple = true
  input.style.display = 'none'
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? [])
    input.remove()
    if (files.length) void insertImageFiles(view, files, view.state.selection.main.head)
  }, { once: true })
  document.body.appendChild(input)
  input.click()
}

/** Coller et deposer des images dans l'editeur, avec cet envoyeur. */
export function imageInsertExtension(upload: ImageUploader): Extension {
  return [
    imageUploader.of(upload),
    pendingInsertions,
    EditorView.domEventHandlers({
      paste(event, view) {
        const data = event.clipboardData
        const files = Array.from(data?.files ?? []).filter(isImageFile)
        // Du texte avec l'image (copie depuis un traitement de texte) : on
        // colle le texte, comme Obsidian.
        if (files.length === 0 || data?.getData('text/plain') || view.state.readOnly) return false
        event.preventDefault()
        void insertImageFiles(view, files, view.state.selection.main.head, true)
        return true
      },
      drop(event, view) {
        const files = Array.from(event.dataTransfer?.files ?? []).filter(isImageFile)
        if (files.length === 0 || view.state.readOnly) return false
        event.preventDefault()
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
        void insertImageFiles(view, files, pos)
        return true
      },
    }),
  ]
}
