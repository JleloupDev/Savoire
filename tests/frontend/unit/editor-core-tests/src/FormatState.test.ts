// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Etat de mise en forme sous le curseur : ce qui allume les boutons de la
// barre d'edition et donne le style du paragraphe.
import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { formatStateAt } from '../../../../../packages/editor-core/src/FormatState'

/** `|` marque le curseur ; `«` et `»` une selection. */
function at(text: string) {
  const sel = text.indexOf('«') >= 0
    ? { anchor: text.indexOf('«'), head: text.indexOf('»') - 1 }
    : { anchor: text.indexOf('|') }
  const doc = text.replace(/[|«»]/g, '')
  return formatStateAt(EditorState.create({ doc, selection: sel, extensions: [markdown({ base: markdownLanguage })] }))
}

describe('formatStateAt', () => {
  it('reconnait le gras, l italique, le barre et le code sous le curseur', () => {
    expect([...at('un **gr|as** mot').inline]).toEqual(['bold'])
    expect([...at('un *ita|lique*').inline]).toEqual(['italic'])
    expect([...at('un ~~bar|re~~').inline]).toEqual(['strike'])
    expect([...at('un `co|de`').inline]).toEqual(['code'])
    expect([...at('rien| ici').inline]).toEqual([])
  })

  it('curseur colle a la fin du gras : allume ; colle au debut : eteint', () => {
    expect(at('**gras**| apres').inline.has('bold')).toBe(true)
    expect(at('avant |**gras**').inline.has('bold')).toBe(false)
  })

  it('une selection prend le style de son debut', () => {
    expect(at('**«gras» et** plus').inline.has('bold')).toBe(true)
  })

  it('donne le style du paragraphe', () => {
    expect(at('## Ti|tre').block).toBe('h2')
    expect(at('> une ci|tation').block).toBe('blockquote')
    expect(at('```\ncode|\n```').block).toBe('codeblock')
    expect(at('du te|xte').block).toBe('paragraph')
  })

  it('distingue les listes', () => {
    expect(at('- un|').list).toBe('ul')
    expect(at('1. un|').list).toBe('ol')
    expect(at('- [ ] tache|').list).toBe('tasklist')
    expect(at('pas de liste|').list).toBe(null)
  })

  it('surlignage et couleurs Plume', () => {
    const s = at('du ==🟢sur|ligne== texte')
    expect(s.inline.has('highlight')).toBe(true)
    expect(s.highlightColor).toBe('green')
    expect(at('du ==sur|ligne==').highlightColor).toBe(null)
    expect(at('`🔴` ligne en rou|ge').textColor).toBe('red')
  })
})
