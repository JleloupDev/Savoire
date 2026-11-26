// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Glisser un fichier de l'explorateur dans une note : la reference inseree,
// et sa place dans une ligne rendue.
import { describe, it, expect } from 'vitest'
import { Text } from '@codemirror/state'
import { fileReferenceInsertion, isEmbeddedOnDrop, sourceOffsetForShown } from '../../../../../packages/editor-core/src/FileDrop'

describe('Reference deposee', () => {
  const doc = Text.of(['Un mot ici', ''])
  it('un lien, avec des espaces s\'il touche un mot', () => {
    expect(fileReferenceInsertion(doc, 4, 'Note', false).insert).toBe(' [[Note]] ')
    expect(fileReferenceInsertion(doc, 3, 'Note', false).insert).toBe('[[Note]] ')
    expect(fileReferenceInsertion(doc, 10, 'Note', false).insert).toBe(' [[Note]]')
    expect(fileReferenceInsertion(doc, 11, 'Note', false)).toEqual({ from: 11, insert: '[[Note]]', cursor: 19 })
  })
  it('une image sur sa propre ligne', () => {
    expect(fileReferenceInsertion(doc, 6, 'photo.png', true).insert).toBe('\n![[photo.png]]\n')
  })
  it('images, videos et sons sont integres ; le reste est lie', () => {
    expect(isEmbeddedOnDrop('a/photo.PNG')).toBe(true)
    expect(isEmbeddedOnDrop('son.mp3')).toBe(true)
    expect(isEmbeddedOnDrop('Note.md')).toBe(false)
    expect(isEmbeddedOnDrop('doc.pdf')).toBe(false)
  })
})

describe('Place dans une ligne rendue', () => {
  it('saute la mise en forme', () => {
    const line = 'Un **mot** et [lien](http://x) fin'
    expect(sourceOffsetForShown(line, 'Un mot')).toBe(line.indexOf('mot') + 3)
    expect(sourceOffsetForShown(line, 'Un mot et lien')).toBe(line.indexOf('lien') + 4)
    expect(sourceOffsetForShown(line, '')).toBe(0)
  })
  it('saute la puce, le numero, la case et le titre', () => {
    expect(sourceOffsetForShown('- [ ] tache a faire', 'tache')).toBe(11)
    expect(sourceOffsetForShown('  12. deux', 'de')).toBe(8)
    expect(sourceOffsetForShown('## Titre', 'Ti')).toBe(5)
  })
  it('null si le texte ne se retrouve pas', () => {
    expect(sourceOffsetForShown('abc', 'abd')).toBeNull()
  })
})
