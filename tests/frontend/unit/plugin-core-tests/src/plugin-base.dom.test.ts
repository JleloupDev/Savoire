// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-base : manifeste partage a deux membres, lignes-pages (cellule ->
// frontmatter), lignes legeres (lots), promotion, kanban, defilement
// virtualise, etat de l'index. Les requetes passent par le vrai fournisseur
// de l'appli (QueryEngineProvider + InMemoryQueryEngine).
import { describe, it, expect, vi } from 'vitest'
import plugin, { TITLE_COLUMN } from '@savoire/plugin-base'
import { InMemoryQueryEngine, InMemorySharedTree } from '@savoire/plugin-runtime'
import { QueryEngineProvider, VaultPropertyTypes, annexDocId } from '@savoire/application'
import type { IVaultSyncSession, QueryVaultSources } from '@savoire/application'
import { BASE_ROW_PREFIX, parseFrontmatter } from '@savoire/plugin-api'
import type { FileContext, FileTypeSpec, IIndexChannel, ITreeMap, PluginAPI, VaultAPI } from '@savoire/plugin-api'

interface Note { id: string; path: string; text: string }

class Channel implements IIndexChannel {
  private readonly map = new Map<string, unknown>()
  private readonly cbs = new Set<(ids: string[]) => void>()
  set(id: string, v: unknown) { this.map.set(id, v); for (const cb of [...this.cbs]) cb([id]) }
  delete(id: string) { this.map.delete(id); for (const cb of [...this.cbs]) cb([id]) }
  getAll() { return [...this.map].map(([id, value]) => ({ id, value })) }
  onChange(cb: (ids: string[]) => void) { this.cbs.add(cb); return () => { this.cbs.delete(cb) } }
  dispose() {}
}

const tick = (ms = 60) => new Promise(r => setTimeout(r, ms))

/** Un vault partage par deux membres : memes notes, arbres de la base et lots relies. */
function world(initial: Omit<Note, 'id'>[]) {
  let counter = 0
  const notes: Note[] = initial.map(n => ({ ...n, id: `n${++counter}` }))
  notes.push({ id: 'base1', path: 'Projets.base', text: '' })
  const changed = new Set<() => void>()
  const notify = () => { for (const cb of [...changed]) cb() }
  const settings = new Channel()
  const trees = new Map<string, InMemorySharedTree[]>()
  const treePair = (id: string) => {
    let p = trees.get(id)
    if (!p) { p = [new InMemorySharedTree(), new InMemorySharedTree()]; InMemorySharedTree.link(p[0], p[1]); trees.set(id, p) }
    return p
  }
  const editText = vi.fn(async (id: string, fn: (s: string) => string) => {
    const note = notes.find(n => n.id === id)!
    const next = fn(note.text)
    if (next === note.text) return false
    note.text = next
    notify()
    return true
  })
  const vault = {
    resolveDocumentId: (path: string) => notes.find(n => n.path === path)?.id,
    editText,
    createFile: vi.fn(async (path: string) => { notes.push({ id: `n${++counter}`, path, text: '' }); notify() }),
    renameFile: vi.fn(async (id: string, path: string) => { notes.find(n => n.id === id)!.path = path; notify() }),
  } as unknown as VaultAPI

  function member(peer: 0 | 1) {
    const session = {
      directory: { getAll: () => notes.map(n => ({ id: n.id, path: n.path })), onChange: (cb: () => void) => { changed.add(cb); return () => changed.delete(cb) } },
      readDocument: async (id: string) => notes.find(n => n.id === id)?.text ?? '',
      openVaultSettings: () => settings,
    } as unknown as IVaultSyncSession
    const types = new VaultPropertyTypes()
    types.attachVault(session)
    const sources: QueryVaultSources = {
      session,
      metadata: {
        getAll: () => notes.filter(n => n.path.endsWith('.md')).map(n => ({
          docId: n.id, path: n.path, crdtVersion: { clock: 0 }, title: '', tags: [], aliases: [], frontmatter: parseFrontmatter(n.text),
        })),
        onChange: cb => { changed.add(cb); return () => changed.delete(cb) },
      },
      types,
      trees: {
        open: async id => treePair(id)[peer],
        close: () => {},
        openAnnex: async (id, name) => treePair(annexDocId(id, name))[peer],
        closeAnnex: () => {},
      },
    }
    const query = new QueryEngineProvider(() => new InMemoryQueryEngine())
    query.attachVault(sources)
    const opened = vi.fn()
    const api = {
      query, properties: types, vault,
      workspace: { openFile: opened },
      files: { register: () => {} },
      commands: { register: () => {} },
    } as unknown as PluginAPI
    return { api, query, types, opened }
  }
  return { notes, vault, editText, member, tree: (id: string, peer: 0 | 1) => treePair(id)[peer], notify }
}

async function spec(): Promise<FileTypeSpec> {
  const specs: FileTypeSpec[] = []
  await plugin.onload({ files: { register: (s: FileTypeSpec) => specs.push(s) }, commands: { register: () => {} } } as unknown as PluginAPI)
  return specs[0]
}

async function mount(w: ReturnType<typeof world>, peer: 0 | 1, api: PluginAPI) {
  const s = await spec()
  // Le plugin garde l'API recue au chargement : on recharge avec celle du membre.
  await plugin.onload({ ...api, files: { register: () => {} }, commands: { register: () => {} } } as unknown as PluginAPI)
  const ctx: FileContext = {
    vaultId: 'v', path: 'Projets.base', tree: w.tree('base1', peer), vault: w.vault,
    shared: {
      openMap: () => { throw new Error('inutile') },
      openTree: async name => w.tree(annexDocId('base1', name), peer),
      closeTree: () => {},
    },
  }
  const el = document.createElement('div')
  document.body.appendChild(el)
  const view = s.open!('Projets.base', ctx)
  view.mount(el)
  return { el, view, ctx }
}

const titles = (el: HTMLElement) => Array.from(el.querySelectorAll('[data-testid="base-row"] [data-testid="base-title"]')).map(n => n.textContent)
const click = (el: Element | null) => (el as HTMLElement).click()
const cell = (el: HTMLElement, rowTitle: string, key: string) => {
  const row = Array.from(el.querySelectorAll('[data-testid="base-row"]')).find(r => r.querySelector('[data-testid="base-title"]')?.textContent === rowTitle)!
  return row.querySelector(`[data-key="${key}"]`) as HTMLElement
}
function typeIn(host: HTMLElement, value: string) {
  const input = host.querySelector('[data-testid="base-editor"]') as HTMLInputElement
  input.value = value
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
}

const NOTES = [
  { path: 'Projets/Alpha.md', text: '---\nstatus: En cours\npriority: 2\n---\n# Alpha' },
  { path: 'Projets/Beta.md', text: '---\nstatus: Fait\npriority: 1\n---\n' },
  { path: 'Autre/Gamma.md', text: '---\nstatus: En cours\n---\n' },
]

describe('plugin-base', () => {
  it('declare le type .base en crdt ; un document neuf reste vide a l ouverture', async () => {
    const s = await spec()
    expect(s).toMatchObject({ extension: 'base', collaborationMode: 'crdt' })
    expect(await s.create()).toBe('')
    const w = world(NOTES)
    const a = w.member(0)
    await mount(w, 0, a.api)
    await tick()
    expect(w.tree('base1', 0).root.keys()).toEqual([])
  })

  it('lignes-pages : les notes du dossier de la base, colonnes decouvertes', async () => {
    const w = world(NOTES)
    const a = w.member(0)
    const { el } = await mount(w, 0, a.api)
    await tick()
    expect(titles(el)).toEqual(['Alpha', 'Beta'])
    const heads = Array.from(el.querySelectorAll('[data-testid="base-th"]')).map(th => (th as HTMLElement).dataset.key)
    expect(heads).toEqual([TITLE_COLUMN, 'status', 'priority'])
    expect(el.querySelector('[data-testid="base-count"]')!.textContent).toBe('2 lignes')
  })

  it('le manifeste se modifie a deux, en temps reel', async () => {
    const w = world(NOTES)
    const a = w.member(0)
    const b = w.member(1)
    const A = await mount(w, 0, a.api)
    const B = await mount(w, 1, b.api)
    await tick()
    // A ajoute une colonne : la premiere modification ecrit tout le manifeste.
    click(A.el.querySelector('[data-testid="base-add-column"]'))
    const name = A.el.querySelector('[data-testid="base-new-column-name"]') as HTMLInputElement
    name.value = 'échéance'
    ;(A.el.querySelector('[data-testid="base-new-column-type"]') as HTMLSelectElement).value = 'date'
    click(A.el.querySelector('[data-testid="base-new-column-ok"]'))
    await tick()
    const keysB = () => Array.from(B.el.querySelectorAll('[data-testid="base-th"]')).map(th => (th as HTMLElement).dataset.key)
    expect(keysB()).toEqual([TITLE_COLUMN, 'status', 'priority', 'échéance'])
    expect(b.types.get('échéance')?.type).toBe('date')
    // B passe la vue en kanban groupe par statut ; A le voit.
    click(B.el.querySelector('[data-testid="base-type-kanban"]'))
    await tick()
    expect(A.el.querySelector('[data-testid="base-kanban"]')).not.toBeNull()
    const lanes = Array.from(A.el.querySelectorAll('[data-testid="base-lane"]')).map(l => (l as HTMLElement).dataset.value)
    expect(lanes).toEqual(['En cours', 'Fait', 'Sans valeur'])
    // Deux vues, ajoutees en meme temps par les deux membres : aucune perdue.
    click(A.el.querySelector('[data-testid="base-add-view"]'))
    await new Promise(r => setTimeout(r, 2))
    click(B.el.querySelector('[data-testid="base-add-view"]'))
    await tick()
    expect(A.el.querySelectorAll('[data-testid="base-tab"]').length).toBe(3)
    expect(B.el.querySelectorAll('[data-testid="base-tab"]').length).toBe(3)
  })

  it('editer une cellule ecrit le frontmatter de la note ; l autre membre le voit', async () => {
    const w = world(NOTES)
    const a = w.member(0)
    const b = w.member(1)
    const A = await mount(w, 0, a.api)
    const B = await mount(w, 1, b.api)
    a.types.set({ key: 'priority', type: 'number' })
    await tick()
    const td = cell(A.el, 'Alpha', 'priority')
    td.dispatchEvent(new MouseEvent('dblclick'))
    typeIn(td, '5')
    await tick()
    expect(w.notes[0].text).toBe('---\nstatus: En cours\npriority: 5\n---\n# Alpha')
    expect(cell(B.el, 'Alpha', 'priority').textContent).toBe('5')
    // Case a cocher : un clic suffit.
    a.types.set({ key: 'done', type: 'checkbox' })
    click(A.el.querySelector('[data-testid="base-add-column"]'))
    ;(A.el.querySelector('[data-testid="base-new-column-name"]') as HTMLInputElement).value = 'done'
    click(A.el.querySelector('[data-testid="base-new-column-ok"]'))
    await tick()
    click(cell(A.el, 'Beta', 'done'))
    await tick()
    expect(parseFrontmatter(w.notes[1].text).done).toBe(true)
  })

  it('nouvelle ligne-page : une note dans le dossier de la base', async () => {
    const w = world(NOTES)
    const a = w.member(0)
    const A = await mount(w, 0, a.api)
    await tick()
    click(A.el.querySelector('[data-testid="base-new-page"]'))
    await tick()
    expect(w.notes.at(-1)!.path).toBe('Projets/Sans titre.md')
    expect(titles(A.el)).toEqual(['Alpha', 'Beta', 'Sans titre'])
  })

  it('lignes legeres : dans un lot, vues par l autre membre, modifiables, promues en page', async () => {
    const w = world(NOTES)
    const a = w.member(0)
    const b = w.member(1)
    const A = await mount(w, 0, a.api)
    const B = await mount(w, 1, b.api)
    await tick()
    click(A.el.querySelector('[data-testid="base-new-row"]'))
    await tick()
    // Le manifeste liste le lot ; le lot porte la ligne.
    const lots = ((w.tree('base1', 1).root.get('base') as ITreeMap).get('lots') as ITreeMap).keys()
    expect(lots).toHaveLength(1)
    const lot = w.tree(annexDocId('base1', `lot-${lots[0].padStart(3, '0')}`), 1)
    const rowKey = lot.root.keys().find(k => k.startsWith(BASE_ROW_PREFIX))!
    expect((lot.root.get(rowKey) as ITreeMap).get('title')).toBe('Sans titre')
    expect(titles(B.el)).toEqual(['Alpha', 'Beta', 'Sans titre'])
    // B renomme la ligne et remplit une cellule : seule la carte de la ligne change.
    const title = cell(B.el, 'Sans titre', TITLE_COLUMN)
    title.dispatchEvent(new MouseEvent('dblclick'))
    typeIn(title, 'Idée')
    await tick()
    const status = cell(B.el, 'Idée', 'status')
    status.dispatchEvent(new MouseEvent('dblclick'))
    typeIn(status, 'Fait')
    await tick()
    expect(titles(A.el)).toEqual(['Alpha', 'Beta', 'Idée'])
    expect(cell(A.el, 'Idée', 'status').textContent).toBe('Fait')
    // Promotion : une note avec ses valeurs en frontmatter, la ligne legere disparait.
    click(cell(A.el, 'Idée', TITLE_COLUMN).querySelector('[data-testid="base-promote"]'))
    await tick(120)
    const page = w.notes.find(n => n.path === 'Projets/Idée.md')!
    expect(parseFrontmatter(page.text)).toEqual({ status: 'Fait' })
    expect(lot.root.keys().filter(k => k.startsWith(BASE_ROW_PREFIX))).toEqual([])
    expect(titles(B.el)).toEqual(['Alpha', 'Beta', 'Idée'])
    expect(B.el.querySelector('[data-testid="base-row"][data-id="' + page.id + '"]')).not.toBeNull()
  })

  it('kanban : deplacer une carte change la valeur de la note', async () => {
    const w = world(NOTES)
    const a = w.member(0)
    const A = await mount(w, 0, a.api)
    await tick()
    click(A.el.querySelector('[data-testid="base-type-kanban"]'))
    await tick()
    const lane = (v: string) => A.el.querySelector(`[data-testid="base-lane"][data-value="${v}"]`) as HTMLElement
    expect(Array.from(lane('En cours').querySelectorAll('[data-testid="base-card"] .base-card-title')).map(c => c.textContent)).toEqual(['Alpha'])
    const card = lane('En cours').querySelector('[data-testid="base-card"]') as HTMLElement
    const data = new Map<string, string>()
    const dataTransfer = { setData: (t: string, v: string) => data.set(t, v), getData: (t: string) => data.get(t) ?? '', effectAllowed: '' }
    const drag = new Event('dragstart'); Object.defineProperty(drag, 'dataTransfer', { value: dataTransfer })
    card.dispatchEvent(drag)
    const drop = new Event('drop', { cancelable: true }); Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer })
    lane('Fait').dispatchEvent(drop)
    await tick()
    expect(parseFrontmatter(w.notes[0].text).status).toBe('Fait')
    expect(Array.from(lane('Fait').querySelectorAll('[data-testid="base-card"] .base-card-title')).map(c => c.textContent)).toEqual(['Alpha', 'Beta'])
  })

  it('defilement virtualise : 5 000 lignes, quelques dizaines dans la page', async () => {
    const engine = new InMemoryQueryEngine()
    engine.upsertMany(Array.from({ length: 5000 }, (_, i) => ({ id: `d${i}`, path: `Projets/N${String(i).padStart(5, '0')}.md`, title: `N${String(i).padStart(5, '0')}`, props: { n: i } })))
    const s = await spec()
    await plugin.onload({ query: engine, vault: { resolveDocumentId: () => undefined }, workspace: { openFile: () => {} }, files: { register: () => {} }, commands: { register: () => {} } } as unknown as PluginAPI)
    const el = document.createElement('div')
    s.open!('Projets.base', { vaultId: 'v', path: 'Projets.base' }).mount(el)
    await tick()
    const rendered = el.querySelectorAll('[data-testid="base-row"]').length
    expect(rendered).toBeGreaterThan(10)
    expect(rendered).toBeLessThan(80)
    expect(el.querySelector('[data-testid="base-count"]')!.textContent).toBe('5000 lignes')
    expect((el.querySelector('[data-testid="base-tbody"]') as HTMLElement).style.height).toBe(`${5000 * 32}px`)
    // Defiler loin : la page voulue est chargee par curseur.
    const scroller = el.querySelector('[data-testid="base-table"]') as HTMLElement
    scroller.scrollTop = 32 * 3000
    scroller.dispatchEvent(new Event('scroll'))
    for (let i = 0; i < 20 && !titles(el).includes('N03000'); i++) await tick(20)
    expect(titles(el)).toContain('N03000')
  })

  it('affiche l etat de l index', async () => {
    const engine = new InMemoryQueryEngine()
    const s = await spec()
    await plugin.onload({ query: engine, vault: { resolveDocumentId: () => undefined }, workspace: { openFile: () => {} }, files: { register: () => {} }, commands: { register: () => {} } } as unknown as PluginAPI)
    const el = document.createElement('div')
    s.open!('B.base', { vaultId: 'v', path: 'B.base' }).mount(el)
    engine.setState({ status: 'building', progress: 0.63 })
    expect(el.querySelector('[data-testid="base-index-state"]')!.textContent).toBe('Index en construction, 63 %')
    engine.setState({ status: 'ready' })
    expect(el.querySelector('[data-testid="base-index-state"]')!.textContent).toBe('')
  })
})
