// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Colonnes (ADR-030) : lire un bloc `::: colonnes`, le reecrire, et deplacer
// des lignes et des blocs comme le fait la poignee du mode classique.
import { describe, it, expect } from 'vitest'
import {
  columnWidths, findColumnsBlocks, insertColumn, linesOf, modelOf, removeUnit, serializeModel, setColumnText,
} from '../../../../../packages/editor-core/src/Columns'
import { planDrop, type Change } from '../../../../../packages/editor-core/src/BlockDrag'

function apply(doc: string, changes: Change[] | null): string {
  if (!changes) throw new Error('depot refuse')
  let out = doc
  for (const c of [...changes].sort((a, b) => b.from - a.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to)
  return out
}

const IMG_TEXT = 'avant\n\n::: colonnes 1 2\n![[photo.jpg]]\n+++\n## Titre\nTexte a droite.\n:::\n\napres'

describe('Colonnes : lecture', () => {
  it('trouve le bloc, ses colonnes et leurs textes', () => {
    const [b] = findColumnsBlocks(linesOf(IMG_TEXT))
    expect(IMG_TEXT.slice(b.from, b.to)).toBe('::: colonnes 1 2\n![[photo.jpg]]\n+++\n## Titre\nTexte a droite.\n:::')
    expect(b.header).toBe('1 2')
    expect(b.columns.map(c => c.text)).toEqual(['![[photo.jpg]]', '## Titre\nTexte a droite.'])
    expect(IMG_TEXT.slice(b.columns[1].from, b.columns[1].to)).toBe('## Titre\nTexte a droite.')
  })

  it('accepte « columns », ignore un bloc sans fermeture et les ::: dans du code', () => {
    expect(findColumnsBlocks(linesOf('::: columns\na\n+++\nb\n:::'))).toHaveLength(1)
    expect(findColumnsBlocks(linesOf('::: colonnes\na\n+++\nb'))).toHaveLength(0)
    expect(findColumnsBlocks(linesOf('```\n::: colonnes\na\n:::\n```'))).toHaveLength(0)
  })

  it('un +++ dans un bloc de code ne coupe pas la colonne', () => {
    const [b] = findColumnsBlocks(linesOf('::: colonnes\n```\n+++\n```\n+++\nb\n:::'))
    expect(b.columns.map(c => c.text)).toEqual(['```\n+++\n```', 'b'])
  })

  it('largeurs : un nombre = combien de colonnes, plusieurs = proportions', () => {
    expect(columnWidths('', 2)).toEqual([1, 1])
    expect(columnWidths('3', 2)).toEqual([1, 1, 1])
    expect(columnWidths('1 2', 2)).toEqual([1, 2])
    expect(columnWidths('30% 70%', 2)).toEqual([30, 70])
    expect(columnWidths('1 2', 3)).toEqual([1, 2, 1.5])
  })
})

describe('Colonnes : modele', () => {
  it('retirer le dernier bloc d\'une colonne la fait disparaitre, une seule colonne defait le bloc', () => {
    const [b] = findColumnsBlocks(linesOf(IMG_TEXT))
    const model = modelOf(b)
    removeUnit(model, 0, 0)
    expect(serializeModel(model)).toBe('## Titre\n\nTexte a droite.')
  })

  it('une nouvelle colonne prend une largeur', () => {
    const [b] = findColumnsBlocks(linesOf(IMG_TEXT))
    const model = modelOf(b)
    insertColumn(model, 2, 'troisieme')
    expect(serializeModel(model)).toBe('::: colonnes 1 2 2\n![[photo.jpg]]\n+++\n## Titre\n\nTexte a droite.\n+++\ntroisieme\n:::')
  })

  it('une colonne encore vide reste (bloc tout juste insere)', () => {
    const [b] = findColumnsBlocks(linesOf('::: colonnes\n\n+++\n\n:::'))
    const model = modelOf(b)
    setColumnText(model, 0, 'Ecrit')
    expect(serializeModel(model)).toBe('::: colonnes\nEcrit\n+++\n\n:::')
  })

  it('reecrire une colonne', () => {
    const [b] = findColumnsBlocks(linesOf(IMG_TEXT))
    const model = modelOf(b)
    setColumnText(model, 1, 'Autre texte')
    expect(serializeModel(model)).toBe('::: colonnes 1 2\n![[photo.jpg]]\n+++\nAutre texte\n:::')
  })
})

describe('Glisser-deposer', () => {
  const DOC = 'un\ndeux\ntrois'

  it('deplace une ligne entre deux lignes', () => {
    // « trois » avant « un ».
    expect(apply(DOC, planDrop(DOC, { kind: 'range', from: 8, to: 13, block: false }, { kind: 'between', pos: 0 }))).toBe('trois\nun\ndeux')
    // « un » a la fin.
    expect(apply(DOC, planDrop(DOC, { kind: 'range', from: 0, to: 2, block: false }, { kind: 'between', pos: DOC.length }))).toBe('deux\ntrois\nun')
  })

  it('refuse un depot sur lui-meme', () => {
    expect(planDrop(DOC, { kind: 'range', from: 3, to: 7, block: false }, { kind: 'side', target: { from: 3, to: 7 }, side: 'right' })).toBeNull()
  })

  it('lache a droite d\'une ligne : les deux passent en colonnes', () => {
    const out = apply(DOC, planDrop(DOC, { kind: 'range', from: 8, to: 13, block: false }, { kind: 'side', target: { from: 0, to: 2 }, side: 'right' }))
    expect(out).toBe('::: colonnes\nun\n+++\ntrois\n:::\n\ndeux')
  })

  it('lache a gauche : la ligne tiree passe en premier', () => {
    const out = apply(DOC, planDrop(DOC, { kind: 'range', from: 0, to: 2, block: false }, { kind: 'side', target: { from: 8, to: 13 }, side: 'left' }))
    expect(out).toBe('deux\n\n::: colonnes\nun\n+++\ntrois\n:::')
  })

  it('sort un bloc d\'une colonne : le bloc de colonnes se defait', () => {
    const [b] = findColumnsBlocks(linesOf(IMG_TEXT))
    const out = apply(IMG_TEXT, planDrop(IMG_TEXT, { kind: 'column-unit', block: b, col: 0, unit: 0 }, { kind: 'between', pos: IMG_TEXT.length }))
    expect(out).toBe('avant\n\n## Titre\n\nTexte a droite.\n\napres\n\n![[photo.jpg]]')
  })

  it('entre une ligne dans une colonne', () => {
    const [b] = findColumnsBlocks(linesOf(IMG_TEXT))
    const out = apply(IMG_TEXT, planDrop(IMG_TEXT, { kind: 'range', from: 0, to: 5, block: false }, { kind: 'into-column', block: b, col: 1, unit: 2 }))
    expect(out).toBe('\n::: colonnes 1 2\n![[photo.jpg]]\n+++\n## Titre\n\nTexte a droite.\n\navant\n:::\n\napres')
  })

  it('passe un bloc d\'une colonne a une nouvelle colonne du meme bloc', () => {
    const [b] = findColumnsBlocks(linesOf(IMG_TEXT))
    const out = apply(IMG_TEXT, planDrop(IMG_TEXT, { kind: 'column-unit', block: b, col: 1, unit: 0 }, { kind: 'new-column', block: b, col: 0 }))
    expect(out).toBe('avant\n\n::: colonnes 2 1 2\n## Titre\n+++\n![[photo.jpg]]\n+++\nTexte a droite.\n:::\n\napres')
  })
})
