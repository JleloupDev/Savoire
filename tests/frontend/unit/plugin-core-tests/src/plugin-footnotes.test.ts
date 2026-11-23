// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Module « Notes de bas de page » : rendu des appels et des definitions,
// retrouver une note, en inserer une.
import { describe, it, expect } from 'vitest'
import plugin, { definitionPos, firstRefPos, footnoteText, insertFootnote, nextFootnoteLabel, renderFootnotes } from '@savoire/plugin-footnotes'

describe('plugin-footnotes — rendu', () => {
  it('l\'appel devient un numero en exposant, la definition une ligne de note', () => {
    expect(renderFootnotes('Une phrase[^1].')).toBe('Une phrase<sup class="plume-fn-ref" data-fn="1">1</sup>.')
    expect(renderFootnotes('[^1]: La note, voir[^2].')).toBe('<sup class="plume-fn-def" data-fn="1">1</sup> La note, voir<sup class="plume-fn-ref" data-fn="2">2</sup>.')
  })

  it('le code n\'est pas touche, ni en ligne ni en bloc', () => {
    expect(renderFootnotes('du `[^1]` ici')).toBe('du `[^1]` ici')
    expect(renderFootnotes('```\n[^1]: x\n```')).toBe('```\n[^1]: x\n```')
  })

  it('le manifeste : actif par defaut, officiel', () => {
    expect(plugin.manifest).toMatchObject({ id: 'plugin-footnotes', defaultActive: true, official: true })
  })
})

describe('plugin-footnotes — aller et revenir', () => {
  const doc = 'Texte[^a] et[^2].\n\n[^a]: Premiere note.\n[^2]: Deuxieme.'
  it('le texte et la place de la note, la place de l\'appel', () => {
    expect(footnoteText(doc, 'a')).toBe('Premiere note.')
    expect(footnoteText(doc, 'x')).toBeNull()
    expect(doc.slice(definitionPos(doc, '2'))).toBe('Deuxieme.')
    expect(firstRefPos(doc, 'a')).toBe('Texte[^a]'.length)
  })
})

describe('plugin-footnotes — inserer', () => {
  const apply = (doc: string, pos: number) => {
    const { changes, cursor } = insertFootnote(doc, pos)
    let out = doc
    for (const c of [...changes].reverse()) out = out.slice(0, c.from) + c.insert + out.slice(c.to)
    return { out, cursor }
  }

  it('l\'appel au curseur, la definition en fin de note apres une ligne vide', () => {
    const { out, cursor } = apply('Une phrase.', 10)
    expect(out).toBe('Une phrase[^1].\n\n[^1]: ')
    expect(cursor).toBe(out.length)
  })

  it('le numero suivant, sous les definitions existantes', () => {
    expect(nextFootnoteLabel('a[^1] b[^3]')).toBe('4')
    const { out } = apply('a[^1] b.\n\n[^1]: x\n', 7)
    expect(out).toBe('a[^1] b[^2].\n\n[^1]: x\n[^2]: ')
  })
})
