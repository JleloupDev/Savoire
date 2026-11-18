// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils d'agent des plugins (ADR-033) : taches, tags, agenda, schemas,
// et le passage commun « faire ou proposer » (changeNoteText).
import { describe, it, expect, vi } from 'vitest'
import { TEXT_PROPOSAL, changeNoteText, minimalChange, type PluginAPI, type ToolContext } from '@savoire/plugin-api'
import { addTask, parseTasks, setTaskDone, taskAgentTools } from '@savoire/plugin-task-list'
import { renameTagIn } from '@savoire/plugin-hashtags'

const actor = { agentId: 'a', agentName: 'Secrétaire', onBehalfOf: { userId: 'u', displayName: 'Jean' } }

function fakeApi(notes: Record<string, string>) {
  const texts = new Map(Object.entries(notes))
  const propose = vi.fn(async () => 'p1')
  const api = {
    vault: {
      getFileTree: () => [...texts.keys()].map(p => ({ docId: p, path: p })),
      resolveDocumentId: (p: string) => (texts.has(p) ? p : undefined),
      read: async (id: string) => texts.get(id) ?? '',
      readDocumentByPath: async (p: string) => texts.get(p) ?? '',
      list: async (dir?: string) => [...texts.keys()].filter(p => !dir || p.startsWith(dir)),
      editText: async (id: string, edit: (s: string) => string) => { texts.set(id, edit(texts.get(id) ?? '')); return true },
    },
    review: { propose },
  } as unknown as PluginAPI
  return { api, texts, propose }
}

describe('taches', () => {
  it('lit, ajoute et coche des taches, hors blocs de code', () => {
    const md = '# Projet\n- [ ] écrire\n- [x] relire\n```\n- [ ] pas une tache\n```\n'
    expect(parseTasks(md).map(t => [t.text, t.done])).toEqual([['écrire', false], ['relire', true]])
    expect(addTask(md, 'publier')).toContain('- [x] relire\n- [ ] publier\n```')
    expect(addTask('Texte', 'a')).toBe('Texte\n\n- [ ] a\n')
    expect(setTaskDone(md, 'écrire', true)).toContain('- [x] écrire')
    expect(setTaskDone('- [ ] a b\n- [ ] a c', 'a', true)).toBeNull()
  })

  it('outil : en direct la note change, en proposition une proposition de texte', async () => {
    const { api, texts, propose } = fakeApi({ 'Projet.md': '- [ ] écrire\n' })
    const add = taskAgentTools(api).find(t => t.spec.name === 'add_task')!
    await add.run({ path: 'Projet', text: 'publier' }, { mode: 'direct', actor } as ToolContext)
    expect(texts.get('Projet.md')).toBe('- [ ] écrire\n- [ ] publier\n')
    await add.run({ path: 'Projet.md', text: 'fêter' }, { mode: 'propose', actor } as ToolContext)
    expect(texts.get('Projet.md')).toBe('- [ ] écrire\n- [ ] publier\n')
    expect(propose).toHaveBeenCalledWith('Projet.md', TEXT_PROPOSAL, expect.objectContaining({ before: '', after: '- [ ] fêter\n' }), expect.stringContaining('Secrétaire'))
    const list = await taskAgentTools(api)[0]!.run({}, { mode: 'direct', actor } as ToolContext)
    expect(list.text).toContain('- [ ] publier')
  })
})

describe('tags', () => {
  it('renomme un tag et ses sous-tags, pas un tag plus long ni le code', () => {
    const md = 'Voir #projet et #projet/a, pas #projets.\n```\n#projet\n```'
    expect(renameTagIn(md, 'projet', 'chantier')).toBe('Voir #chantier et #chantier/a, pas #projets.\n```\n#projet\n```')
  })
})

describe('faire ou proposer', () => {
  it('la plus petite plage, et rien quand rien ne change', async () => {
    expect(minimalChange('abcXdef', 'abcYYdef')).toEqual({ from: 3, to: 4, text: 'YY' })
    const { api } = fakeApi({ 'n.md': 'x' })
    expect(await changeNoteText(api, { mode: 'direct', actor }, 'n.md', s => s, 'rien')).toBe('unchanged')
  })
})
