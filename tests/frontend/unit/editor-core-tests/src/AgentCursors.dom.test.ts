// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un agent IA dans la note, en direct : etiquette la ou il ecrit, trait dans
// la marge du passage qu'il lit ou ecrit, robot « lit… / ecrit… », bouton « Suivre ».
// Rien quand personne ne travaille.
import { describe, it, expect, afterEach } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { AgentPeer } from '@savoire/plugin-api'
import { agentCursorsExtension, type AgentFollowStore } from '../../../../../packages/editor-core/src/AgentCursors'
import { agentPresenceExtension } from '../../../../../packages/editor-core/src/AgentPresence'
import { blockMarksExtension, blockMarksOf } from '../../../../../packages/editor-core/src/BlockMarks'

const views: EditorView[] = []
afterEach(() => { for (const v of views.splice(0)) v.destroy() })

/** La source : ce que le CRDT du document dit des agents presents. */
function fakeSource() {
  let peers: AgentPeer[] = []
  const listeners = new Set<() => void>()
  return {
    list: () => peers,
    subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    async set(next: AgentPeer[]) {
      peers = next
      for (const cb of [...listeners]) cb()
      // L'affichage attend la fin du tour (jamais pendant une mise a jour de l'editeur).
      await Promise.resolve()
    },
    listeners,
  }
}

function memoryFollow(on = false): AgentFollowStore & { on: boolean } {
  return { on, get() { return this.on }, set(v: boolean) { this.on = v } }
}

const DOC = 'Titre\n\nBonjour tout le monde.\n\nDernier paragraphe.'

function open(source: ReturnType<typeof fakeSource>, follow = memoryFollow()) {
  const scrolls: number[] = []
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: DOC, extensions: [agentPresenceExtension(), blockMarksExtension(), agentCursorsExtension(source, follow)] }),
    dispatchTransactions: (trs, v) => {
      for (const tr of trs) if (tr.scrollIntoView || tr.effects.some(e => e.value && typeof e.value === 'object' && 'range' in (e.value as object) && 'y' in (e.value as object))) scrolls.push(1)
      v.update(trs)
    },
  })
  views.push(view)
  const box = view.dom.querySelector('[data-testid="agent-presence"]') as HTMLElement
  const chip = () => box.querySelector('.cm-agent-presence-chip') as HTMLElement | null
  const action = () => box.querySelector('[data-testid="agent-presence-action"]') as HTMLButtonElement | null
  const tags = () => [...view.dom.querySelectorAll('[data-testid="agent-tag"]')] as HTMLElement[]
  const marks = () => [...blockMarksOf(view).values()].flat()
  return { view, box, chip, action, tags, marks, scrolls, follow }
}

const writing: AgentPeer = { key: '77', name: 'Archiviste', color: '#00aa77', state: 'writing', from: 7, to: 29, onBehalfOf: 'Jean' }
const reading: AgentPeer = { key: '77', name: 'Archiviste', color: '#00aa77', state: 'reading', from: 7, to: 29 }

describe('un agent IA dans la note, en direct', () => {
  it('rien tant qu aucun agent ne travaille', async () => {
    const source = fakeSource()
    const e = open(source)
    await source.set([])
    expect(e.box.hidden).toBe(true)
    expect(e.tags()).toHaveLength(0)
    expect(e.marks()).toHaveLength(0)
  })

  it('il ecrit : etiquette a son nom la ou il ecrit, robot « ecrit… », dans sa couleur', async () => {
    const source = fakeSource()
    const e = open(source)
    await source.set([writing])
    expect(e.box.hidden).toBe(false)
    expect(e.chip()!.textContent).toContain('Archiviste écrit…')
    expect(e.chip()!.title).toBe('Archiviste (IA), pour Jean')
    expect(e.chip()!.style.color).toBe('#00aa77')
    expect(e.tags().map(t => t.textContent)).toEqual(['Archiviste écrit…'])
    expect(e.tags()[0]!.style.backgroundColor).toBe('#00aa77')
    // L'etiquette est a la fin de ce qu'il vient d'ecrire.
    expect(e.view.posAtDOM(e.tags()[0]!.parentElement!)).toBe(29)
    // Un trait dans la marge, visible meme quand le paragraphe est rendu (modes power et classique).
    expect(e.marks()).toEqual([{ from: 7, to: 29, className: 'cm-block-agent-writing', title: 'Archiviste écrit ici…', color: '#00aa77' }])
  })

  it('il lit : un trait le long du passage, robot « lit… », pas d etiquette', async () => {
    const source = fakeSource()
    const e = open(source)
    await source.set([reading])
    expect(e.chip()!.textContent).toContain('Archiviste lit…')
    expect(e.marks()).toEqual([{ from: 7, to: 29, className: 'cm-block-agent-reading', title: 'Archiviste lit ce passage…', color: '#00aa77' }])
    expect(e.tags()).toHaveLength(0)
  })

  it('il part : tout disparait', async () => {
    const source = fakeSource()
    const e = open(source)
    await source.set([reading])
    await source.set([writing])
    expect(e.marks().map(m => m.className)).toEqual(['cm-block-agent-writing'])
    expect(e.tags()).toHaveLength(1)
    await source.set([])
    expect(e.box.hidden).toBe(true)
    expect(e.tags()).toHaveLength(0)
    expect(e.marks()).toHaveLength(0)
  })

  it('la personne tape avant : l etiquette suit le texte', async () => {
    const source = fakeSource()
    const e = open(source)
    await source.set([writing])
    e.view.dispatch({ changes: { from: 0, insert: 'Hier. ' } })
    expect(e.view.posAtDOM(e.tags()[0]!.parentElement!)).toBe(35)
  })

  it('suivre : coupe par defaut, la vue ne bouge pas ; allume, elle suit chaque deplacement de l agent', async () => {
    const source = fakeSource()
    const e = open(source)
    await source.set([writing])
    expect(e.action()!.textContent).toBe('Suivre')
    expect(e.action()!.getAttribute('aria-pressed')).toBe('false')
    expect(e.scrolls).toHaveLength(0)

    e.action()!.click()
    await Promise.resolve()
    expect(e.follow.on).toBe(true)
    expect(e.action()!.textContent).toBe('Suivi')
    expect(e.action()!.getAttribute('aria-pressed')).toBe('true')
    expect(e.scrolls).toHaveLength(1)
    // Meme endroit : pas de nouveau saut (la personne peut faire defiler).
    await source.set([{ ...writing }])
    expect(e.scrolls).toHaveLength(1)
    await source.set([{ ...writing, to: 40 }])
    expect(e.scrolls).toHaveLength(2)
    // Il lit ailleurs : la vue va au debut du passage.
    await source.set([{ ...reading, from: 31, to: 50 }])
    expect(e.scrolls).toHaveLength(3)

    e.action()!.click()
    await Promise.resolve()
    expect(e.follow.on).toBe(false)
    await source.set([{ ...writing, to: 12 }])
    expect(e.scrolls).toHaveLength(3)
  })

  it('le choix « suivre » vaut pour la note suivante', async () => {
    const source = fakeSource()
    const e = open(source, memoryFollow(true))
    await source.set([writing])
    expect(e.action()!.getAttribute('aria-pressed')).toBe('true')
    expect(e.scrolls).toHaveLength(1)
  })

  it('editeur ferme : plus d abonnement', async () => {
    const source = fakeSource()
    const e = open(source)
    expect(source.listeners.size).toBe(1)
    e.view.destroy()
    expect(source.listeners.size).toBe(0)
    await source.set([writing])
  })
})
