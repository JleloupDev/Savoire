// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// « Modifications de l'IA » dans le panneau Revision (AiChangesSection) : la
// liste des points de la note active, « Voir », « Annuler », et l'ouverture
// sur un point depuis ailleurs (showAiChange, evenement de fenetre).
// Le CRDT est le vrai adaptateur Yjs de l'appli.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AiChangesSection } from '../../../../../apps/web/src/AiChangesSection'
import {
  SHOW_AI_CHANGE_EVENT, describeAiChange, describeAiChangeSize, findAiChange, installAiChangeHistory, showAiChange, takeAiChangeFocus,
} from '../../../../../apps/web/src/aiChangeHistory'
import { YjsCrdtAdapter } from '../../../../../packages/infrastructure-sync/src/YjsCrdtAdapter'
import type { AiChangeInfo } from '@savoire/plugin-api'

const CAMILLE = { id: 'u2', name: 'Camille' }
const ARCHIVISTE = { agent: { id: 'a1', name: 'Archiviste', color: '#0a7fc2' }, forUser: { id: 'u1', name: 'Jean' } }

/** Une note ouverte par une session qui compte ses ouvertures. */
function oneNote(content: string) {
  const crdt = new YjsCrdtAdapter()
  const shared = crdt.sharedText()
  shared.applyDelta([{ insert: content }])
  let opened = 0
  const session = {
    openDocument() { opened++; return crdt },
    closeDocument() { opened-- },
    documentLoaded: () => Promise.resolve(),
  }
  /** Une ecriture d'agent : ajoute `text` a `at`, avec son point. Rend l'id du point. */
  const agentAdds = (at: number, text: string, summary: string, reason?: string): string => {
    // Une seconde entre deux ecritures : l'ordre des points est celui des ecritures.
    vi.setSystemTime(Date.now() + 1000)
    const rec = crdt.beginAiChange({ ...ARCHIVISTE, summary, ...(reason ? { reason } : {}) })
    rec.capture(() => shared.applyDelta([...(at > 0 ? [{ retain: at }] : []), { insert: text }]))
    return rec.commit()!
  }
  return { crdt, session, agentAdds, text: () => shared.toString(), opened: () => opened }
}

let host: HTMLDivElement
let root: Root
let stop: (() => void) | undefined

beforeEach(() => {
  // L'heure seule est simulee (celle des points) ; les minuteries restent vraies.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-25T10:00:00Z') })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  stop?.()
  stop = undefined
  // Aucune demande ne traine d'un test a l'autre.
  takeAiChangeFocus('d1')
  vi.useRealTimers()
})

const selectRange = vi.fn()
const editor = () => ({ selectRange, getDocId: () => 'd1' }) as never

async function render(n: ReturnType<typeof oneNote>, canWrite = true): Promise<void> {
  await act(async () => {
    root.render(<AiChangesSection session={n.session as never} docId="d1" me={CAMILLE} canWrite={canWrite} editor={editor} />)
  })
}

const items = () => Array.from(host.querySelectorAll<HTMLElement>('[data-testid="ai-change-item"]'))
const within = (el: Element, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click() })

describe('la section « Modifications de l’IA »', () => {
  it('rien tant que la note n a aucun point ; la note est rendue a la fermeture', async () => {
    const n = oneNote('Bonjour.')
    await render(n)
    expect(host.querySelector('[data-testid="ai-changes-section"]')).toBeNull()
    expect(n.opened()).toBe(1)
    await act(async () => { root.render(<div />) })
    expect(n.opened()).toBe(0)
  })

  it('un point : l agent et sa couleur, pour qui, quoi, pourquoi, la taille ; un nouveau point arrive seul', async () => {
    const n = oneNote('Bonjour. Fin.')
    n.agentAdds(9, 'Texte de l’IA. ', 'passage remplacé', 'plus clair')
    await render(n)
    expect(host.querySelector('[data-testid="ai-changes-section"]')!.textContent).toContain('Modifications de l’IA')
    expect(items()).toHaveLength(1)
    const item = items()[0]!
    expect(within(item, 'ai-change-agent')!.textContent).toBe('Archiviste')
    expect(within(item, 'ai-change-agent')!.style.color).toBe('#0a7fc2')
    expect(within(item, 'ai-change-for')!.textContent).toBe('pour Jean')
    expect(within(item, 'ai-change-time')!.textContent).toMatch(/\d/)
    expect(within(item, 'ai-change-summary')!.textContent).toBe('passage remplacé')
    expect(within(item, 'ai-change-reason')!.textContent).toBe('Pourquoi : plus clair')
    expect(within(item, 'ai-change-size')!.textContent).toBe('+15 / −0 caractères')
    expect(within(item, 'ai-change-show')!.textContent).toBe('Voir')
    expect(within(item, 'ai-change-undo')!.textContent).toBe('Annuler')

    // L'agent ecrit encore : la liste se met a jour, le plus recent en tete.
    await act(async () => { n.agentAdds(0, 'Titre. ', '7 caractères ajoutés') })
    expect(items().map(i => within(i, 'ai-change-summary')!.textContent)).toEqual(['7 caractères ajoutés', 'passage remplacé'])
  })

  it('« Voir » selectionne dans l editeur le texte ajoute, la ou il est aujourd hui', async () => {
    const n = oneNote('Bonjour. Fin.')
    n.agentAdds(9, 'Texte de l’IA. ', 'passage remplacé')
    // La personne a tape devant depuis.
    n.crdt.sharedText().applyDelta([{ insert: '> ' }])
    await render(n)
    selectRange.mockClear()
    await click(within(items()[0]!, 'ai-change-show'))
    expect(selectRange).toHaveBeenCalledWith(11, 26)
  })

  it('« Annuler » retire ce que l agent a ecrit, et le dit : « Annulée par », plus de bouton', async () => {
    const n = oneNote('Bonjour. Fin.')
    n.agentAdds(9, 'Texte de l’IA. ', 'passage remplacé')
    n.crdt.sharedText().applyDelta([{ insert: '> ' }])
    await render(n)
    await click(within(items()[0]!, 'ai-change-undo'))
    expect(n.text()).toBe('> Bonjour. Fin.')
    const item = items()[0]!
    expect(item.dataset.undone).toBe('true')
    expect(within(item, 'ai-change-undone')!.textContent).toBe('Annulée par Camille')
    expect(within(item, 'ai-change-undo')).toBeNull()
    expect(within(item, 'ai-change-show')).toBeNull()
  })

  it('en lecture seule : on voit, on n annule pas', async () => {
    const n = oneNote('Bonjour.')
    n.agentAdds(8, ' Suite.', 'texte ajouté')
    await render(n, false)
    expect(within(items()[0]!, 'ai-change-show')).not.toBeNull()
    expect(within(items()[0]!, 'ai-change-undo')).toBeNull()
  })

  it('au-dela de cinq points : les plus recents, puis « Tout afficher »', async () => {
    const n = oneNote('Bonjour.')
    for (let i = 0; i < 7; i++) n.agentAdds(0, `${i} `, `ajout ${i}`)
    await render(n)
    expect(items()).toHaveLength(5)
    const more = host.querySelector('[data-testid="ai-changes-more"]')!
    expect(more.textContent).toBe('Tout afficher (7)')
    await click(more)
    expect(items()).toHaveLength(7)
  })
})

describe('ouvrir l historique sur un point', () => {
  it('showAiChange ouvre le panneau et met le point en avant, par l id d un point range', async () => {
    const n = oneNote('Bonjour.')
    const first = n.agentAdds(8, ' Un.', 'premier')
    n.agentAdds(0, 'Deux. ', 'second')
    const openPanel = vi.fn()
    stop = installAiChangeHistory(openPanel)
    await render(n)
    expect(items().every(i => i.dataset.focused === 'false')).toBe(true)
    await act(async () => { showAiChange('d1', first) })
    expect(openPanel).toHaveBeenCalledTimes(1)
    // Le plus recent en tete : le point demande est le second.
    expect(items().map(i => [i.dataset.changeId === first, i.dataset.focused])).toEqual([[false, 'false'], [true, 'true']])
  })

  it('demande faite avant que le panneau soit monte (evenement de fenetre) : prise a l ouverture', async () => {
    const n = oneNote('Bonjour.')
    const id = n.agentAdds(8, ' Un.', 'premier')
    const openPanel = vi.fn()
    stop = installAiChangeHistory(openPanel)
    window.dispatchEvent(new CustomEvent(SHOW_AI_CHANGE_EVENT, { detail: { docId: 'd1', changeId: id } }))
    expect(openPanel).toHaveBeenCalledTimes(1)
    await render(n)
    expect(items()[0]!.dataset.focused).toBe('true')
  })

  it('une demande pour une autre note attend cette note ; une vieille demande est oubliee', () => {
    stop = installAiChangeHistory(() => undefined)
    showAiChange('autre', 'x')
    expect(takeAiChangeFocus('d1')).toBeNull()
    expect(takeAiChangeFocus('autre')).toMatchObject({ docId: 'autre', changeId: 'x' })
    expect(takeAiChangeFocus('autre')).toBeNull()
    showAiChange('d1', 'y')
    expect(takeAiChangeFocus('d1', Date.now() + 60_000)).toBeNull()
    // Sans note : la note active, quelle qu'elle soit.
    showAiChange()
    expect(takeAiChangeFocus('d1')).toMatchObject({ at: expect.any(Number) })
  })
})

describe('le texte d une ligne', () => {
  const info = (p: Partial<AiChangeInfo>): AiChangeInfo => ({
    id: 'p1', parts: ['p1'], at: '2026-11-25T10:00:00.000Z', agent: { id: 'a1', name: 'Archiviste' },
    summaries: [], reasons: [], count: 1, inserted: 0, deleted: 0, ...p,
  })

  it('un point compacte : « 3 modifications », et ce qu elles sont', () => {
    expect(describeAiChange(info({ summaries: ['passage remplacé'] }))).toBe('passage remplacé')
    expect(describeAiChange(info({}))).toBe('1 modification')
    expect(describeAiChange(info({ count: 3, summaries: ['passage remplacé', '1 retouche', 'passage remplacé'] }))).toBe('3 modifications : passage remplacé ×2, 1 retouche')
    expect(describeAiChange(info({ count: 2 }))).toBe('2 modifications')
  })

  it('la taille, et le point d un id range', () => {
    expect(describeAiChangeSize(info({ inserted: 120, deleted: 8 }))).toBe('+120 / −8 caractères')
    expect(describeAiChangeSize(info({ inserted: 1, deleted: 0 }))).toBe('+1 / −0 caractère')
    const list = [info({ id: 'a', parts: ['a', 'b'] }), info({ id: 'c', parts: ['c'] })]
    expect(findAiChange(list, 'b')?.id).toBe('a')
    expect(findAiChange(list, 'c')?.id).toBe('c')
    expect(findAiChange(list, 'inconnu')).toBeUndefined()
  })
})
