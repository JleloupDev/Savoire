// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Logique d'arbre du plugin Plans (.outline) : fonctions pures.
import { describe, expect, it } from 'vitest'
import {
  addNote,
  ancestors,
  backspaceItem,
  dedentItem,
  diffToChange,
  diffToChanges,
  enterItem,
  enterNote,
  indentItem,
  itemLabel,
  moveItem,
  parseOutline,
  selectItem,
  toggleChecked,
  zoomRange,
  type OutlineEdit,
} from '@savoire/plugin-outline'
import plugin from '@savoire/plugin-outline'

/** Texte avec un « | » pour le curseur -> [texte, position]. */
function at(src: string): [string, number] {
  const pos = src.indexOf('|')
  return [src.slice(0, pos) + src.slice(pos + 1), pos]
}

/** Resultat d'une operation, avec le curseur marque d'un « | ». */
function show(edit: OutlineEdit | null): string | null {
  if (!edit) return null
  return edit.text.slice(0, edit.head) + '|' + edit.text.slice(edit.head)
}

describe('plugin-outline — manifeste', () => {
  it('declare le type .outline, creatable, en mode crdt', async () => {
    expect(plugin.manifest).toMatchObject({ id: 'plugin-outline', name: 'Plans', scope: 'vault', permissions: ['ui:editor'] })
    const specs: Array<{ extension: string; collaborationMode?: string; creatable?: boolean; create(): Promise<string> }> = []
    const commands: string[] = []
    await plugin.onload({
      files: { register: (s: never) => specs.push(s), unregister: () => {} },
      commands: { register: (c: { id: string }) => commands.push(c.id), unregister: () => {} },
    } as never)
    expect(specs[0]).toMatchObject({ extension: 'outline', label: 'Plan', collaborationMode: 'crdt', creatable: true })
    expect(await specs[0].create()).toBe('- ')
    expect(commands.every(id => id.startsWith('outline:'))).toBe(true)
    expect(commands).toContain('outline:zoom-in')
  })
})

describe('plugin-outline — lecture de l\'arbre', () => {
  it('reconnait niveaux, enfants, cases et lignes de suite', () => {
    const o = parseOutline('- a\n  - b\n    note\n  - [x] c\n- d\n')
    expect(o.items.map(i => [itemLabel(o, i), i.depth, i.parent])).toEqual([
      ['a', 0, -1], ['b', 1, 0], ['c', 1, 0], ['d', 0, -1],
    ])
    expect(o.items[2].checked).toBe(true)
    expect(o.items[0].endLine).toBe(3)
    // La ligne vide de fin n'appartient a aucun sous-arbre.
    expect(o.items[3].endLine).toBe(4)
    expect(o.owner[2]).toBe(1)
    expect(ancestors(o, o.items[2]).map(i => itemLabel(o, i))).toEqual(['a'])
  })

  it('« - » seul et « - » sans espace final sont des elements vides', () => {
    const o = parseOutline('- \n-\n---')
    expect(o.items).toHaveLength(2)
  })
})

describe('plugin-outline — indenter / desindenter', () => {
  it('Tab indente l\'element avec ses enfants', () => {
    const [t, p] = at('- a\n- b|\n  - c\n- d')
    expect(show(indentItem(t, p))).toBe('- a\n  - b|\n    - c\n- d')
  })

  it('Tab sans frere precedent ne fait rien', () => {
    const [t, p] = at('- a|\n- b')
    expect(indentItem(t, p)).toBeNull()
  })

  it('Maj+Tab desindente avec les enfants et place l\'element apres son parent', () => {
    const [t, p] = at('- a\n  - b|\n    - c\n  - d\n- e')
    expect(show(dedentItem(t, p))).toBe('- a\n  - d\n- b|\n  - c\n- e')
  })

  it('Maj+Tab a la racine ne fait rien', () => {
    const [t, p] = at('- a|')
    expect(dedentItem(t, p)).toBeNull()
  })
})

describe('plugin-outline — deplacer', () => {
  it('monte l\'element avec ses enfants au-dessus de son frere', () => {
    const [t, p] = at('- a\n  - a1\n- b|\n  - b1\n- c')
    expect(show(moveItem(t, p, 'up'))).toBe('- b|\n  - b1\n- a\n  - a1\n- c')
  })

  it('descend l\'element avec ses enfants, curseur dans un enfant', () => {
    const [t, p] = at('- a\n  - a|1\n    - x\n  - a2\n- b')
    expect(show(moveItem(t, p, 'down'))).toBe('- a\n  - a2\n  - a|1\n    - x\n- b')
    const [t2, p2] = at('- a|\n  - a1\n- b\n  - b1\n')
    expect(show(moveItem(t2, p2, 'down'))).toBe('- b\n  - b1\n- a|\n  - a1\n')
  })

  it('garde la ligne vide entre deux freres', () => {
    const [t, p] = at('- a\n\n- b|')
    expect(show(moveItem(t, p, 'up'))).toBe('- b|\n\n- a')
  })

  it('premier frere : rien a monter', () => {
    const [t, p] = at('- a|\n- b')
    expect(moveItem(t, p, 'up')).toBeNull()
  })
})

describe('plugin-outline — Entree', () => {
  it('coupe l\'element : la suite devient un frere', () => {
    const [t, p] = at('- ab|cd\n- e')
    expect(show(enterItem(t, p))).toBe('- ab\n- |cd\n- e')
  })

  it('element avec enfants deplies : nouvel enfant en premier', () => {
    const [t, p] = at('- a|\n  - b')
    expect(show(enterItem(t, p))).toBe('- a\n  - |\n  - b')
  })

  it('element plie : nouveau frere apres tout le sous-arbre', () => {
    const [t, p] = at('- a|\n  - b\n- c')
    expect(show(enterItem(t, p, { isFolded: () => true }))).toBe('- a\n  - b\n- |\n- c')
  })

  it('element vide : remonte d\'un niveau', () => {
    const [t, p] = at('- a\n  - |\n  - b')
    expect(show(enterItem(t, p))).toBe('- a\n  - b\n- |')
  })

  it('element vide a la racine : rien ne change', () => {
    const [t, p] = at('- a\n- |')
    expect(show(enterItem(t, p))).toBe('- a\n- |')
  })

  it('au debut d\'un element : nouvel element vide au-dessus', () => {
    const [t, p] = at('- |abc')
    expect(show(enterItem(t, p))).toBe('- \n- |abc')
  })

  it('reprend la case, decochee', () => {
    const [t, p] = at('- [x] a|')
    expect(show(enterItem(t, p))).toBe('- [x] a\n- [ ] |')
  })

  it('racine d\'un zoom sans enfant : nouvel enfant', () => {
    const [t, p] = at('- a|\n- b')
    expect(show(enterItem(t, p, { forceChild: () => true }))).toBe('- a\n  - |\n- b')
  })

  it('hors d\'un element : comportement normal', () => {
    const [t, p] = at('- a\n  note|')
    expect(enterItem(t, p)).toBeNull()
  })
})

describe('plugin-outline — Retour arriere', () => {
  it('au debut d\'un element vide : le supprime et rejoint le precedent', () => {
    const [t, p] = at('- a\n- |\n- c')
    expect(show(backspaceItem(t, p))).toBe('- a|\n- c')
  })

  it('au debut d\'un element non vide : son texte rejoint le precedent', () => {
    const [t, p] = at('- a\n  - |b')
    expect(show(backspaceItem(t, p))).toBe('- a|b')
  })

  it('saute les lignes masquees (pliage)', () => {
    const [t, p] = at('- a\n  - a1\n- |')
    expect(show(backspaceItem(t, p, { isHidden: l => l === 1 }))).toBe('- a|\n  - a1')
  })

  it('ailleurs : comportement normal', () => {
    const [t, p] = at('- a|b')
    expect(backspaceItem(t, p)).toBeNull()
  })
})

describe('plugin-outline — notes', () => {
  it('Maj+Entree depuis l\'element : note apres ses notes, avant ses enfants', () => {
    const [t, p] = at('- a|\n  une note\n  - b')
    expect(show(addNote(t, p))).toBe('- a\n  une note\n  |\n  - b')
  })

  it('Entree dans une note : on en sort, nouvel element apres', () => {
    const [t, p] = at('- a\n  une| note\n- b')
    expect(show(enterNote(t, p))).toBe('- a\n  une note\n- |\n- b')
  })

  it('Maj+Entree dans une note : nouvelle ligne de note', () => {
    const [t, p] = at('- a\n  une| note')
    expect(show(addNote(t, p))).toBe('- a\n  une\n  | note')
  })

  it('nouvel enfant : apres les notes de l\'element', () => {
    const [t, p] = at('- a|\n  note\n  - b')
    expect(show(enterItem(t, p))).toBe('- a\n  note\n  - |\n  - b')
  })

  it('une note n\'est pas un element', () => {
    const o = parseOutline('- a\n  une note\n  - b')
    expect(o.items).toHaveLength(2)
    expect(o.owner[1]).toBe(0)
  })
})

describe('plugin-outline — zoom, selection, cases, diff', () => {
  it('zoom : le sous-arbre de l\'element du curseur', () => {
    const [t, p] = at('- a\n- b|\n  - c\n- d')
    const z = zoomRange(t, p)!
    expect(t.slice(z.from, z.to)).toBe('- b\n  - c')
  })

  it('Ctrl+A : l\'element, puis tout', () => {
    const [t, p] = at('- a\n- b|c\n- d')
    const first = selectItem(t, p, p)
    expect(t.slice(first.anchor, first.head)).toBe('bc')
    const second = selectItem(t, first.anchor, first.head)
    expect([second.anchor, second.head]).toEqual([0, t.length])
    const scoped = selectItem(t, first.anchor, first.head, { from: 4, to: 8 })
    expect([scoped.anchor, scoped.head]).toEqual([4, 8])
  })

  it('coche et decoche une case', () => {
    expect(toggleChecked('- [ ] a', 3)!.text).toBe('- [x] a')
    expect(toggleChecked('  - [x] a', 5)!.text).toBe('  - [ ] a')
  })

  it('changement minimal', () => {
    expect(diffToChange('- a\n- b', '- a\n  - b')).toEqual({ from: 4, to: 4, insert: '  ' })
    expect(diffToChange('abc', 'abc')).toBeNull()
    // Indentage : une insertion par ligne, pas un bloc remplace.
    expect(diffToChanges('- a\n- b\n  - c', '- a\n  - b\n    - c')).toEqual([
      { from: 4, to: 4, insert: '  ' }, { from: 10, to: 10, insert: '  ' },
    ])
    // Ligne ajoutee en fin de texte (Entree) : position dans les bornes.
    expect(diffToChanges('- a', '- a\n- ')).toEqual([{ from: 3, to: 3, insert: '\n- ' }])
    expect(diffToChanges('- a\n- b', '- b\n- a\n- c')).toEqual([{ from: 2, to: 7, insert: 'b\n- a\n- c' }])
  })
})
