// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
import { EditorState, Text } from '@codemirror/state'
import {
  imageInsertion, pastedImageName, imageExtensionOf, insertImageFiles, imageInsertExtension, pickAndInsertImages,
} from '../../../../../packages/editor-core/src/ImageInsert'

const apply = (doc: string, pos: number, targets: string[]) => {
  const spec = imageInsertion(Text.of(doc.split('\n')), pos, targets)!
  const out = doc.slice(0, spec.from) + spec.insert + doc.slice(spec.from)
  return { out, cursor: spec.cursor, at: out.slice(spec.cursor) }
}

describe('nom d\'une image collee', () => {
  it('« Pasted image AAAAMMJJHHmmss.png », comme Obsidian', () => {
    expect(pastedImageName(new Date(2026, 9, 6, 9, 5, 3))).toBe('Pasted image 20261006090503.png')
    expect(pastedImageName(new Date(2026, 0, 1, 23, 59, 59), 'jpg')).toBe('Pasted image 20260101235959.jpg')
  })

  it('extension d\'apres le type MIME', () => {
    expect(imageExtensionOf('image/png')).toBe('png')
    expect(imageExtensionOf('image/jpeg')).toBe('jpg')
    expect(imageExtensionOf('image/svg+xml')).toBe('svg')
    expect(imageExtensionOf('')).toBe('png')
  })
})

describe('insertion au point de depot', () => {
  it('ligne vide : l\'image prend la ligne, le curseur passe dessous', () => {
    const r = apply('', 0, ['a.png'])
    expect(r.out).toBe('![[a.png]]\n')
    expect(r.cursor).toBe(r.out.length)
  })

  it('au milieu d\'une ligne : la ligne est coupee, l\'image a sa propre ligne', () => {
    const r = apply('avant apres', 6, ['a.png'])
    expect(r.out).toBe('avant \n![[a.png]]\napres')
    expect(r.at).toBe('apres')
  })

  it('en fin de ligne suivie de texte', () => {
    const r = apply('un\ndeux', 2, ['a.png'])
    expect(r.out).toBe('un\n![[a.png]]\n\ndeux')
  })

  it('en debut de ligne : rien avant, la ligne descend', () => {
    const r = apply('texte', 0, ['a.png'])
    expect(r.out).toBe('![[a.png]]\ntexte')
    expect(r.at).toBe('texte')
  })

  it('plusieurs fichiers : une ligne chacun, dans l\'ordre', () => {
    const r = apply('x', 1, ['a.png', 'dossier/b.png'])
    expect(r.out).toBe('x\n![[a.png]]\n![[dossier/b.png]]\n')
  })

  it('aucun lien : rien a inserer', () => {
    expect(imageInsertion(Text.of(['x']), 0, [])).toBeNull()
  })

  it('une position hors du document est ramenee au bord', () => {
    expect(apply('ab', 99, ['a.png']).out).toBe('ab\n![[a.png]]\n')
  })
})

// Vue minimale : le chemin d'envoi ne se sert que de state et dispatch.
function view(doc: string, upload?: (f: File) => Promise<string>, readOnly = false) {
  const v = {
    state: EditorState.create({
      doc,
      extensions: [...(upload ? [imageInsertExtension(upload)] : []), EditorState.readOnly.of(readOnly)],
    }),
    dispatch(spec: Parameters<EditorState['update']>[0]) { v.state = v.state.update(spec).state },
    focus() {},
  }
  return v as unknown as import('@codemirror/view').EditorView & { state: EditorState }
}
const png = (name = 'photo.png') => new File([new Uint8Array([1])], name, { type: 'image/png' })

describe('envoi puis insertion (coller, deposer, bouton : un seul chemin)', () => {
  it('insere le lien rendu par l\'envoyeur au point de depot', async () => {
    const v = view('debut fin', async f => f.name)
    await insertImageFiles(v, [png()], 6)
    expect(v.state.doc.toString()).toBe('debut \n![[photo.png]]\nfin')
  })

  it('le point de depot suit les modifications faites pendant l\'envoi', async () => {
    let release: (t: string) => void = () => {}
    const v = view('ab', () => new Promise<string>(r => { release = r }))
    const done = insertImageFiles(v, [png()], 2)
    await Promise.resolve()
    // Quelqu'un tape au debut pendant l'envoi.
    v.dispatch({ changes: { from: 0, insert: 'XYZ ' } })
    release('photo.png')
    await done
    expect(v.state.doc.toString()).toBe('XYZ ab\n![[photo.png]]\n')
  })

  it('une image collee est renommee « Pasted image ... »', async () => {
    const upload = vi.fn(async (f: File) => f.name)
    const v = view('', upload)
    await insertImageFiles(v, [png('image.png')], 0, true)
    expect(upload.mock.calls[0][0].name).toMatch(/^Pasted image \d{14}\.png$/)
  })

  it('un fichier depose garde son nom ; un echec n\'empeche pas les autres', async () => {
    const upload = vi.fn(async (f: File) => { if (f.name === 'casse.png') throw new Error('refuse'); return f.name })
    const v = view('', upload)
    await insertImageFiles(v, [png('casse.png'), png('Vacances.png')], 0)
    expect(v.state.doc.toString()).toBe('![[Vacances.png]]\n')
  })

  it('ignore ce qui n\'est pas une image, et ne fait rien en lecture seule', async () => {
    const upload = vi.fn(async (f: File) => f.name)
    expect(await insertImageFiles(view('', upload), [new File(['t'], 'notes.txt', { type: 'text/plain' })], 0)).toBe(false)
    expect(await insertImageFiles(view('', upload, true), [png()], 0)).toBe(false)
    expect(upload).not.toHaveBeenCalled()
  })

  it('sans envoyeur, le bouton Image insere un lien ![[]] a remplir', () => {
    const v = view('')
    pickAndInsertImages(v)
    expect(v.state.doc.toString()).toBe('![[]]')
    expect(v.state.selection.main.head).toBe(3)
  })
})
