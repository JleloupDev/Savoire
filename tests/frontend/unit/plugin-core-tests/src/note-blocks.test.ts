// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, expect, it } from 'vitest'
import { blockAt, blockFingerprint, blockIdInsertion, newBlockId, splitNoteBlocks } from '@savoire/plugin-api'

const NOTE = `---
tags: [a]
---
# Titre

Premier paragraphe
sur deux lignes.

- un
- deux ^liste

\`\`\`js
const a = 1

const b = 2
\`\`\`

## Suite

> citation

| a | b |
|---|---|
| 1 | 2 |

^tab
---
Fin.`

describe('splitNoteBlocks', () => {
  const blocks = splitNoteBlocks(NOTE)

  it('decoupe en blocs avec leur genre', () => {
    expect(blocks.map(b => b.kind)).toEqual(['frontmatter', 'heading', 'paragraph', 'list', 'code', 'heading', 'quote', 'table', 'rule', 'paragraph'])
  })

  it('donne la place exacte de chaque bloc', () => {
    for (const b of blocks) expect(NOTE.slice(b.from, b.to)).toBe(b.text)
    expect(blocks[2].text).toBe('Premier paragraphe\nsur deux lignes.')
  })

  it('garde un bloc de code entier, lignes vides comprises', () => {
    expect(blocks[4].text).toContain('const b = 2')
  })

  it('lit les identifiants ^id, en fin de ligne ou seuls sous le bloc', () => {
    expect(blocks[3].blockId).toBe('liste')
    expect(blocks[7].blockId).toBe('tab')
  })

  it('range chaque bloc dans sa section', () => {
    expect(blocks[2].section).toBe('Titre')
    expect(blocks[6].section).toBe('Suite')
    expect(blocks[1].level).toBe(1)
  })

  it('une empreinte qui ne change que si le texte change', () => {
    const again = splitNoteBlocks(`Intro\n\n${NOTE.slice(NOTE.indexOf('# Titre'))}`)
    const para = again.find(b => b.text.startsWith('Premier'))!
    expect(para.hash).toBe(blocks[2].hash)
    expect(para.from).not.toBe(blocks[2].from)
    expect(blockFingerprint('Un texte ^abc')).toBe(blockFingerprint('Un texte   '))
    expect(blockFingerprint('Un texte')).not.toBe(blockFingerprint('Un texte.'))
  })

  it('trouve le bloc sous le curseur', () => {
    expect(blockAt(blocks, NOTE.indexOf('deux lignes'))?.index).toBe(2)
    expect(blockAt(blocks, NOTE.indexOf('Premier') - 1)).toBeNull()
  })

  it('note sans frontmatter, retours Windows', () => {
    const b = splitNoteBlocks('A\r\nB\r\n\r\nC')
    expect(b.map(x => x.text)).toEqual(['A\nB', 'C'])
  })
})

describe('identifiants de bloc', () => {
  it('un identifiant libre', () => {
    let n = 0
    const seq = [0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
    expect(newBlockId(['aaaaaa'], () => seq[n++])).toBe('ssssss')
  })

  it('ou ecrire ^id', () => {
    const [p, t] = splitNoteBlocks('Texte\n\n| a |\n|---|')
    expect(blockIdInsertion(p, 'x1')).toEqual({ at: 5, insert: ' ^x1' })
    expect(blockIdInsertion(t, 'x1')).toEqual({ at: t.to, insert: '\n^x1' })
  })
})
