// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Voir ce que fait l'IA : une modification d'un agent arrive surlignee dans
// sa couleur, suit le texte, puis s'efface ; une suppression laisse une
// trace barree ; la zone s'ouvre sur une carte (qui, quoi, pourquoi,
// « Annuler », « Historique ») tant qu'elle se voit. Ni les points deja la a
// l'ouverture, ni les anciens, ni les points compactes ne sont montres.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { AiChangeInfo, AiChangeRanges, AiChangeWho } from '@savoire/plugin-api'
import {
  AI_FLASH_MS, AI_FLASH_FRESH_MS, aiChangeFlashExtension, aiChangeFlashFor, aiChangeFlashes, aiFlashStrength, openedAiChange, setAiChangeHost,
  type AiChangeFlashSource, type AiChangeHost,
} from '../../../../../packages/editor-core/src/AiChangeFlash'
import { blockMarksExtension, blockMarksOf } from '../../../../../packages/editor-core/src/BlockMarks'

const T0 = Date.parse('2026-11-25T10:00:00Z')
const JEAN: AiChangeWho = { id: 'u1', name: 'Jean' }

const views: EditorView[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => {
  for (const v of views.splice(0)) v.destroy()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Un point, tel que le CRDT le montre. `ago` : ecrit il y a tant de millisecondes. */
function point(id: string, over: Partial<AiChangeInfo> = {}, ago = 0): AiChangeInfo {
  return {
    id, parts: [id], at: new Date(Date.now() - ago).toISOString(),
    agent: { id: 'a1', name: 'Archiviste', color: '#00aa77' }, forUser: JEAN,
    summaries: ['passage remplacé'], reasons: ['plus clair'], count: 1, inserted: 0, deleted: 0,
    ...over,
  }
}

/** La source : ce que le CRDT de la note dit de ses points. */
function fakeSource() {
  let infos: AiChangeInfo[] = []
  const where = new Map<string, AiChangeRanges>()
  const listeners = new Set<(added: string[]) => void>()
  const undone: { parts: string[]; by: AiChangeWho }[] = []
  const source: AiChangeFlashSource = {
    list: () => infos,
    subscribe: cb => { listeners.add(cb); return () => { listeners.delete(cb) } },
    ranges: parts => ({
      inserted: parts.flatMap(p => where.get(p)?.inserted ?? []),
      deleted: parts.flatMap(p => where.get(p)?.deleted ?? []),
    }),
    undo: (parts, by) => { undone.push({ parts: [...parts], by }); return api.undoResult },
  }
  const api = {
    source,
    listeners,
    undone,
    undoResult: { ok: true, partial: false },
    /** Range un point sans prevenir (il est deja la a l'ouverture). */
    store(info: AiChangeInfo, ranges: Partial<AiChangeRanges>) {
      infos = [info, ...infos.filter(i => i.id !== info.id)]
      where.set(info.id, { inserted: ranges.inserted ?? [], deleted: ranges.deleted ?? [] })
    },
    /** Previent que des points viennent d'apparaitre. L'affichage attend la fin du tour. */
    async notify(added: string[]) {
      for (const cb of [...listeners]) cb(added)
      await Promise.resolve()
    },
    /** Un point arrive (ecrit ici ou recu d'un autre). */
    async add(info: AiChangeInfo, ranges: Partial<AiChangeRanges>) {
      api.store(info, ranges)
      await api.notify([info.id])
    },
    /** Quelqu'un d'autre annule le point. */
    async undoElsewhere(id: string) {
      infos = infos.map(i => (i.id === id ? { ...i, undone: { at: new Date().toISOString(), by: JEAN } } : i))
      await api.notify([])
    },
  }
  return api
}

const DOC = 'Titre\n\nBonjour tout le monde.\n\nDernier paragraphe.'
// « tout le monde » : [15, 28).
const ADDED = { from: 15, to: 28 }

function open(src: ReturnType<typeof fakeSource>, host?: AiChangeHost, extra: { readOnly?: boolean } = {}) {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: DOC,
      extensions: [
        blockMarksExtension(),
        // happy-dom n'a pas de mise en page : la selection a la souris de CodeMirror y echoue.
        Prec.highest(EditorView.domEventHandlers({ mousedown: () => true })),
        aiChangeFlashExtension(src.source, { docId: 'doc-1', ...(host ? { host } : {}) }),
        ...(extra.readOnly ? [EditorState.readOnly.of(true)] : []),
      ],
    }),
  })
  views.push(view)
  const flashed = () => Array.from(view.dom.querySelectorAll('.cm-ai-flash')) as HTMLElement[]
  const traces = () => Array.from(view.dom.querySelectorAll('[data-testid="ai-flash-deleted"]')) as HTMLElement[]
  const marks = () => [...blockMarksOf(view).values()].flat()
  const css = () => (view.dom.querySelector('style[data-ai-flash]') as HTMLStyleElement).textContent ?? ''
  const card = () => view.dom.querySelector('[data-testid="ai-change-card"]') as HTMLElement | null
  const inCard = (testid: string) => card()?.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null
  const mouse = (el: Element, type: string) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }))
  return { view, flashed, traces, marks, css, card, inCard, mouse }
}

function recordingHost(me: AiChangeWho | null = JEAN) {
  const shown: { docId: string; id: string }[] = []
  const host: AiChangeHost = { me: () => me, showHistory: (docId, id) => { shown.push({ docId, id }) } }
  return { host, shown }
}

describe('voir ce que fait l IA : le surlignage', () => {
  it('rien tant que l IA n a rien change', async () => {
    const src = fakeSource()
    const e = open(src)
    await src.notify([])
    expect(e.flashed()).toHaveLength(0)
    expect(e.marks()).toHaveLength(0)
    expect(e.css()).toBe('')
  })

  it('un point arrive : le texte ajoute est surligne dans la couleur de l agent, avec un trait dans la marge', async () => {
    const src = fakeSource()
    const e = open(src)
    await src.add(point('p1'), { inserted: [ADDED] })
    expect(e.flashed().map(el => el.textContent)).toEqual(['tout le monde'])
    expect(e.flashed()[0]!.dataset.aiChange).toBe('p1')
    expect(aiChangeFlashes(e.view.state)).toEqual([{ id: 'p1', color: '#00aa77', inserted: [ADDED], deleted: [] }])
    // Sa couleur (#00aa77), pleine au debut.
    expect(e.css()).toContain('background-color:rgba(0,170,119,0.320)')
    // Le texte rendu (modes power et classique) : un surlignage du navigateur, meme couleur.
    expect(e.css()).toMatch(/::highlight\(plume-ai-flash-\d+\)\{background-color:rgba\(0,170,119,0\.320\)\}/)
    // Le trait de la marge se voit dans tous les modes.
    expect(e.marks()).toMatchObject([{ from: 15, to: 28, color: '#00aa77', title: 'Archiviste (IA), pour Jean vient de modifier ce passage' }])
    expect(e.marks()[0]!.className).toMatch(/^cm-block-ai-flash cm-block-ai-flash-\d+$/)
    // La note n'est pas touchee.
    expect(e.view.state.doc.toString()).toBe(DOC)
  })

  it('un agent sans couleur (ou avec une couleur douteuse) prend celle par defaut', async () => {
    const src = fakeSource()
    const e = open(src)
    await src.add(point('p1', { agent: { id: 'a1', name: 'Archiviste' } }), { inserted: [ADDED] })
    await src.add(point('p2', { agent: { id: 'a2', name: 'Autre', color: 'red;}body{display:none' } }), { inserted: [{ from: 0, to: 5 }] })
    expect(aiChangeFlashes(e.view.state).map(f => f.color)).toEqual(['#7c3aed', '#7c3aed'])
    expect(e.css()).not.toContain('display:none')
  })

  it('le surlignage suit le texte ; ce qu on tape a ses bords n y entre pas', async () => {
    const src = fakeSource()
    const e = open(src)
    await src.add(point('p1'), { inserted: [ADDED] })
    e.view.dispatch({ changes: { from: 0, insert: 'Hier. ' } })
    expect(aiChangeFlashes(e.view.state)[0]!.inserted).toEqual([{ from: 21, to: 34 }])
    e.view.dispatch({ changes: { from: 21, insert: 'vraiment ' } })
    e.view.dispatch({ changes: { from: 43, insert: ' entier' } })
    expect(e.flashed().map(el => el.textContent)).toEqual(['tout le monde'])
    // Tape au milieu : c'est dans la zone.
    e.view.dispatch({ changes: { from: 35, insert: 'beau ' } })
    expect(e.flashed().map(el => el.textContent).join('')).toBe('tout beau le monde')
    // Le trait de la marge suit aussi.
    expect(e.marks()).toMatchObject([{ from: 30, to: 48 }])
  })

  it('il s efface peu a peu, puis disparait : plus de surlignage, plus de trait, plus de carte', async () => {
    const src = fakeSource()
    const e = open(src, recordingHost().host)
    await src.add(point('p1'), { inserted: [ADDED] })
    const alpha = () => Number(/\.cm-ai-flash-\d+\{background-color:rgba\(0,170,119,([\d.]+)\)/.exec(e.css())?.[1])
    const full = alpha()
    vi.advanceTimersByTime(AI_FLASH_MS / 2)
    const half = alpha()
    expect(half).toBeLessThan(full)
    expect(half).toBeGreaterThan(0)
    vi.advanceTimersByTime(AI_FLASH_MS / 4)
    expect(alpha()).toBeLessThan(half)
    expect(e.flashed()).toHaveLength(1)
    vi.advanceTimersByTime(AI_FLASH_MS / 2)
    await Promise.resolve()
    expect(e.flashed()).toHaveLength(0)
    expect(aiChangeFlashes(e.view.state)).toEqual([])
    expect(e.marks()).toHaveLength(0)
    expect(e.css()).toBe('')
    // Une fois efface, le texte n'ouvre plus la carte.
    e.mouse(e.view.contentDOM.querySelector('.cm-line')!, 'mousedown')
    expect(e.card()).toBeNull()
    // Plus d'horloge qui tourne.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('la force du surlignage : pleine un instant, puis vers rien ; tenue tant que la carte est ouverte', () => {
    expect(aiFlashStrength(0)).toBe(1)
    expect(aiFlashStrength(500)).toBe(1)
    expect(aiFlashStrength(AI_FLASH_MS / 2)).toBeGreaterThan(0.3)
    expect(aiFlashStrength(AI_FLASH_MS / 2)).toBeLessThan(0.8)
    expect(aiFlashStrength(AI_FLASH_MS)).toBe(0)
    expect(aiFlashStrength(AI_FLASH_MS * 2)).toBe(0)
    expect(aiFlashStrength(AI_FLASH_MS, true)).toBeGreaterThan(0.3)
    // Sans animation : plein jusqu'au bout.
    expect(aiFlashStrength(AI_FLASH_MS - 1, false, true)).toBe(1)
  })

  it('sans animation (reglage du systeme) : montre sans fondu, puis retire', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }))
    const src = fakeSource()
    const e = open(src)
    await src.add(point('p1'), { inserted: [ADDED] })
    const before = e.css()
    vi.advanceTimersByTime(AI_FLASH_MS - 400)
    expect(e.css()).toBe(before)
    expect(e.flashed()).toHaveLength(1)
    vi.advanceTimersByTime(800)
    expect(e.flashed()).toHaveLength(0)
    expect(e.css()).toBe('')
  })

  it('plusieurs a la fois, chacun son rythme ; le meme point qui revient repart de zero', async () => {
    const src = fakeSource()
    const e = open(src)
    await src.add(point('p1'), { inserted: [{ from: 0, to: 5 }] })
    vi.advanceTimersByTime(3000)
    await src.add(point('p2', { agent: { id: 'a2', name: 'Relecteur', color: '#cc3300' } }), { inserted: [ADDED] })
    expect(e.flashed().map(el => el.textContent)).toEqual(['Titre', 'tout le monde'])
    expect(e.css()).toContain('rgba(204,51,0,0.320)')
    vi.advanceTimersByTime(3000)
    // Le premier est parti, le second continue.
    expect(aiChangeFlashes(e.view.state).map(f => f.id)).toEqual(['p2'])
    await src.notify(['p2'])
    expect(e.css()).toContain('rgba(204,51,0,0.320)')
    vi.advanceTimersByTime(3000)
    expect(aiChangeFlashes(e.view.state).map(f => f.id)).toEqual(['p2'])
    vi.advanceTimersByTime(3000)
    expect(aiChangeFlashes(e.view.state)).toEqual([])
  })
})

describe('voir ce que fait l IA : ce qui n est pas montre', () => {
  it('les points deja la a l ouverture de la note (chargement)', async () => {
    const src = fakeSource()
    // Ecrit dix secondes avant d'ouvrir la note : recent, mais deja la.
    src.store(point('avant', {}, 10_000), { inserted: [ADDED] })
    vi.advanceTimersByTime(0)
    const e = open(src)
    await src.notify(['avant'])
    expect(e.flashed()).toHaveLength(0)
    expect(e.marks()).toHaveLength(0)
    // Un point ecrit ensuite, lui, se voit.
    vi.advanceTimersByTime(1000)
    await src.add(point('apres'), { inserted: [{ from: 0, to: 5 }] })
    expect(e.flashed().map(el => el.textContent)).toEqual(['Titre'])
  })

  it('les points anciens (retour de connexion), les points compactes, les points annules, ceux sans trace', async () => {
    const src = fakeSource()
    const e = open(src)
    vi.advanceTimersByTime(AI_FLASH_FRESH_MS + 20_000)
    await src.add(point('vieux', {}, AI_FLASH_FRESH_MS + 5000), { inserted: [ADDED] })
    await src.add(point('c|a1|u1|5888', { parts: ['c|a1|u1|5888'] }), { inserted: [ADDED] })
    await src.add(point('annule', { undone: { at: new Date().toISOString(), by: JEAN } }), { inserted: [ADDED] })
    await src.add(point('vide'), { inserted: [{ from: 4, to: 4 }] })
    await src.notify(['inconnu'])
    expect(e.flashed()).toHaveLength(0)
    expect(aiChangeFlashes(e.view.state)).toEqual([])
    expect(e.marks()).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('un point annule par quelqu un d autre pendant qu on le montre : sa trace part', async () => {
    const src = fakeSource()
    const e = open(src)
    await src.add(point('p1'), { inserted: [ADDED] })
    expect(e.flashed()).toHaveLength(1)
    await src.undoElsewhere('p1')
    expect(e.flashed()).toHaveLength(0)
    expect(e.marks()).toHaveLength(0)
  })

  it('un CRDT sans points de l IA : pas d extension ; editeur ferme : plus d abonnement', async () => {
    expect(aiChangeFlashFor(undefined)).toEqual([])
    expect(aiChangeFlashFor({ onAiChangesChange: () => () => {} } as never)).toEqual([])
    const src = fakeSource()
    const e = open(src)
    await src.add(point('p1'), { inserted: [ADDED] })
    expect(src.listeners.size).toBe(1)
    e.view.destroy()
    expect(src.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await src.notify(['p1'])
  })
})

describe('voir ce que fait l IA : une suppression', () => {
  it('laisse une trace barree a sa place, dans la couleur de l agent, qui s efface', async () => {
    const src = fakeSource()
    const e = open(src)
    await src.add(point('p1', { summaries: ['passage supprimé'] }), { deleted: [{ at: 15, text: 'vraiment\n  tout ' }] })
    expect(e.traces().map(t => t.textContent)).toEqual(['vraiment tout'])
    expect(e.traces()[0]!.dataset.aiChange).toBe('p1')
    expect(e.traces()[0]!.getAttribute('aria-label')).toBe('Supprimé par Archiviste (IA), pour Jean')
    // A sa place : juste avant « tout le monde ».
    expect(e.view.posAtDOM(e.traces()[0]!)).toBe(15)
    expect(e.css()).toMatch(/\.cm-ai-flash-del-\d+\{color:rgb\(0,170,119\);opacity:1\.000\}/)
    // Dans un bloc rendu la trace ne se voit pas : il reste le trait de la marge.
    expect(e.marks()).toMatchObject([{ from: 15, to: 15, color: '#00aa77' }])
    // Rien n'est ecrit dans la note.
    expect(e.view.state.doc.toString()).toBe(DOC)
    // Elle suit le texte.
    e.view.dispatch({ changes: { from: 0, insert: 'Hier. ' } })
    expect(aiChangeFlashes(e.view.state)[0]!.deleted).toEqual([{ at: 21, text: 'vraiment\n  tout ' }])
    vi.advanceTimersByTime(AI_FLASH_MS + 400)
    expect(e.traces()).toHaveLength(0)
    expect(e.marks()).toHaveLength(0)
  })

  it('un long texte supprime est coupe ; un remplacement montre l ancien barre devant le nouveau', async () => {
    const src = fakeSource()
    const e = open(src)
    await src.add(point('long'), { deleted: [{ at: 0, text: 'mot '.repeat(100) }] })
    const text = e.traces()[0]!.textContent!
    expect(text.length).toBeLessThanOrEqual(80)
    expect(text.endsWith('…')).toBe(true)
    await src.add(point('remplace'), { inserted: [ADDED], deleted: [{ at: 15, text: 'la terre' }] })
    const line = e.flashed()[0]!.closest('.cm-line')!
    expect(line.textContent).toBe('Bonjour la terretout le monde.')
    expect(e.view.state.doc.toString()).toBe(DOC)
  })
})

describe('voir ce que fait l IA : la carte d un point', () => {
  it('un clic sur la zone ouvre la carte : qui, pour qui, quoi, pourquoi', async () => {
    const src = fakeSource()
    const e = open(src, recordingHost().host)
    await src.add(point('p1', { reasons: ['plus clair', 'demandé par Jean'] }), { inserted: [ADDED] })
    expect(e.card()).toBeNull()
    e.mouse(e.flashed()[0]!, 'mousedown')
    expect(openedAiChange(e.view.state)).toBe('p1')
    expect(e.inCard('ai-change-who')!.textContent).toBe('Archiviste (IA), pour Jean')
    expect(e.card()!.querySelector('.cm-ai-change-summary')!.textContent).toBe('Passage remplacé')
    expect(Array.from(e.card()!.querySelectorAll('.cm-ai-change-reason')).map(r => r.textContent)).toEqual(['plus clair', 'demandé par Jean'])
    expect(e.inCard('ai-change-undo')!.textContent).toBe('Annuler')
    expect(e.inCard('ai-change-history')!.textContent).toBe('Historique')
    // Un clic ailleurs la ferme.
    e.mouse(e.view.contentDOM.querySelector('.cm-line')!, 'mousedown')
    expect(e.card()).toBeNull()
  })

  it('le survol l ouvre apres un instant ; elle se ferme quand la souris s en va, pas quand elle va dessus', async () => {
    const src = fakeSource()
    const e = open(src, recordingHost().host)
    await src.add(point('p1'), { inserted: [ADDED] })
    e.mouse(e.flashed()[0]!, 'mousemove')
    expect(e.card()).toBeNull()
    vi.advanceTimersByTime(300)
    expect(e.card()).not.toBeNull()
    // De la zone a la carte : elle reste.
    e.mouse(e.view.contentDOM.querySelector('.cm-line')!, 'mousemove')
    vi.advanceTimersByTime(200)
    e.mouse(e.card()!, 'mousemove')
    vi.advanceTimersByTime(1000)
    expect(e.card()).not.toBeNull()
    // Ailleurs : elle se ferme.
    e.mouse(e.view.contentDOM.querySelector('.cm-line')!, 'mousemove')
    vi.advanceTimersByTime(500)
    expect(e.card()).toBeNull()
    // Un passage rapide sur la zone n'ouvre rien.
    e.mouse(e.flashed()[0]!, 'mousemove')
    e.mouse(e.view.contentDOM.querySelector('.cm-line')!, 'mousemove')
    vi.advanceTimersByTime(600)
    expect(e.card()).toBeNull()
  })

  it('la trace d une suppression et le trait de la marge ouvrent aussi la carte', async () => {
    const src = fakeSource()
    const e = open(src, recordingHost().host)
    await src.add(point('p1'), { deleted: [{ at: 15, text: 'la terre' }] })
    e.mouse(e.traces()[0]!, 'mousedown')
    expect(openedAiChange(e.view.state)).toBe('p1')
    // La carte dit ce qui a ete supprime (dans un bloc rendu, la trace ne se voit pas).
    expect(Array.from(e.card()!.querySelectorAll('.cm-ai-change-deleted')).map(d => d.textContent)).toEqual(['la terre'])
    e.mouse(e.view.contentDOM.querySelector('.cm-line')!, 'mousedown')
    expect(openedAiChange(e.view.state)).toBeNull()
    // La case de la marge et son trait, tels que la marge les dessine (BlockMarks).
    const box = document.createElement('div')
    box.className = 'cm-block-mark'
    const bar = document.createElement('span')
    bar.className = `cm-block-mark-bar ${e.marks()[0]!.className}`
    box.appendChild(bar)
    e.view.dom.appendChild(box)
    e.mouse(box, 'mousedown')
    expect(openedAiChange(e.view.state)).toBe('p1')
    box.remove()
  })

  it('« Annuler » annule ce point, au nom de la personne ; la trace part, la carte le dit', async () => {
    const src = fakeSource()
    const e = open(src, recordingHost().host)
    await src.add(point('p1'), { inserted: [ADDED] })
    e.mouse(e.flashed()[0]!, 'mousedown')
    e.inCard('ai-change-undo')!.click()
    expect(src.undone).toEqual([{ parts: ['p1'], by: JEAN }])
    expect(e.inCard('ai-change-status')!.textContent).toBe('Modification annulée.')
    expect((e.inCard('ai-change-undo') as HTMLButtonElement).disabled).toBe(true)
    expect(e.flashed()).toHaveLength(0)
    expect(e.marks()).toHaveLength(0)
    // Pas deux fois.
    e.inCard('ai-change-undo')!.click()
    expect(src.undone).toHaveLength(1)
    // La carte fermee, il ne reste rien.
    e.mouse(e.view.contentDOM.querySelector('.cm-line')!, 'mousedown')
    expect(e.card()).toBeNull()
    await Promise.resolve()
    vi.advanceTimersByTime(400)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('une annulation partielle, ou sans effet, est dite clairement', async () => {
    const src = fakeSource()
    const e = open(src, recordingHost().host)
    await src.add(point('p1'), { inserted: [ADDED] })
    src.undoResult = { ok: true, partial: true }
    e.mouse(e.flashed()[0]!, 'mousedown')
    e.inCard('ai-change-undo')!.click()
    expect(e.inCard('ai-change-status')!.textContent).toBe('Annulée en partie : du texte supprimé n’a pas pu être remis à sa place.')
    e.mouse(e.view.contentDOM.querySelector('.cm-line')!, 'mousedown')

    await src.add(point('p2'), { inserted: [{ from: 0, to: 5 }] })
    src.undoResult = { ok: false, partial: false }
    e.mouse(e.flashed()[0]!, 'mousedown')
    e.inCard('ai-change-undo')!.click()
    expect(e.inCard('ai-change-status')!.textContent).toBe('Rien à annuler : cette modification l’a déjà été.')
  })

  it('un point compacte en plusieurs parts : toutes partent a l annulation', async () => {
    const src = fakeSource()
    const e = open(src, recordingHost().host)
    src.store(point('p1', { parts: ['p1', 'p1b'] }), { inserted: [ADDED] })
    await src.notify(['p1b'])
    e.mouse(e.flashed()[0]!, 'mousedown')
    e.inCard('ai-change-undo')!.click()
    expect(src.undone).toEqual([{ parts: ['p1', 'p1b'], by: JEAN }])
  })

  it('« Historique » demande a l appli de montrer le point, et ferme la carte', async () => {
    const src = fakeSource()
    const { host, shown } = recordingHost()
    const e = open(src, host)
    await src.add(point('p1'), { inserted: [ADDED] })
    e.mouse(e.flashed()[0]!, 'mousedown')
    e.inCard('ai-change-history')!.click()
    expect(shown).toEqual([{ docId: 'doc-1', id: 'p1' }])
    expect(e.card()).toBeNull()
  })

  it('sans hote : la carte montre le point, sans boutons ; un hote pose apres coup les apporte', async () => {
    const src = fakeSource()
    const e = open(src)
    await src.add(point('p1'), { inserted: [ADDED] })
    e.mouse(e.flashed()[0]!, 'mousedown')
    expect(e.inCard('ai-change-who')!.textContent).toBe('Archiviste (IA), pour Jean')
    expect(e.inCard('ai-change-undo')).toBeNull()
    expect(e.inCard('ai-change-history')).toBeNull()
    e.mouse(e.view.contentDOM.querySelector('.cm-line')!, 'mousedown')
    setAiChangeHost(e.view, recordingHost().host)
    e.mouse(e.flashed()[0]!, 'mousedown')
    expect(e.inCard('ai-change-undo')).not.toBeNull()
    expect(e.inCard('ai-change-history')).not.toBeNull()
  })

  it('pas de « Annuler » sans personne connue, ni dans une note en lecture seule', async () => {
    const src = fakeSource()
    const anonymous = open(src, recordingHost(null).host)
    const readOnly = open(src, recordingHost().host, { readOnly: true })
    await src.add(point('p1'), { inserted: [ADDED] })
    for (const e of [anonymous, readOnly]) {
      e.mouse(e.flashed()[0]!, 'mousedown')
      expect(e.inCard('ai-change-undo')).toBeNull()
      expect(e.inCard('ai-change-history')).not.toBeNull()
    }
  })

  it('la carte ouverte retient le surlignage ; fermee, il part ; Echap la ferme', async () => {
    const src = fakeSource()
    const e = open(src, recordingHost().host)
    await src.add(point('p1'), { inserted: [ADDED] })
    e.mouse(e.flashed()[0]!, 'mousedown')
    vi.advanceTimersByTime(AI_FLASH_MS * 2)
    expect(e.card()).not.toBeNull()
    expect(e.flashed()).toHaveLength(1)
    // Tenu, pas efface.
    expect(e.css()).not.toContain('rgba(0,170,119,0.000)')
    e.card()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(e.card()).toBeNull()
    vi.advanceTimersByTime(400)
    expect(e.flashed()).toHaveLength(0)
  })

  it('la carte suit le texte sans etre redessinee', async () => {
    const src = fakeSource()
    const e = open(src, recordingHost().host)
    await src.add(point('p1'), { inserted: [ADDED] })
    e.mouse(e.flashed()[0]!, 'mousedown')
    const card = e.card()
    e.view.dispatch({ changes: { from: 0, insert: 'Hier. ' } })
    expect(e.card()).toBe(card)
    expect(openedAiChange(e.view.state)).toBe('p1')
    // La personne se remet a ecrire : la carte s'efface.
    e.view.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' })
    await Promise.resolve()
    expect(e.card()).toBeNull()
  })
})
