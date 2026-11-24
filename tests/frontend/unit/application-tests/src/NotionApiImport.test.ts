// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Import Notion par l'API (ADR-035) : blocs -> page, bases -> .base, client
// au debit de Notion, import progressif qui reprend.
import { describe, it, expect } from 'vitest'
import {
  NotionClient, NotionImportJob, baseManifestOf, notionBlocksToPage, notionIdFromUrl, propertyDefs, propertyValueOf,
  type NotionApiPort, type NotionBlock, type NotionHttpReply, type NotionImportState, type NotionImportTarget, type PageNode,
} from '@savoire/application'

const ID = (n: number) => n.toString(16).padStart(32, '0')
const rt = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'text', plain_text: text, text: { content: text }, annotations: {}, ...extra })
const block = (id: number, type: string, data: Record<string, unknown> = {}, children?: NotionBlock[]): NotionBlock =>
  ({ id: ID(id), type, has_children: !!children?.length, [type]: data, ...(children ? { children } : {}) })

const ctx = {
  linkTarget: (id: string) => (id === ID(500) ? 'Espace/Projet' : id === ID(600) ? 'Espace/Tâches.base' : null),
  fileOf: (id: string) => (id === ID(9) ? 'Espace/Accueil/photo.png' : null),
}

const types = (nodes: PageNode[] | undefined) => (nodes ?? []).map(n => n.type)

describe('Notion -> page', () => {
  it('convertit titres, listes groupees, taches, citation, code et separateur', () => {
    const { doc } = notionBlocksToPage([
      block(1, 'heading_1', { rich_text: [rt('Titre')] }),
      block(2, 'bulleted_list_item', { rich_text: [rt('a')] }, [block(3, 'bulleted_list_item', { rich_text: [rt('a1')] })]),
      block(4, 'bulleted_list_item', { rich_text: [rt('b')] }),
      block(5, 'to_do', { rich_text: [rt('fait')], checked: true }),
      block(6, 'quote', { rich_text: [rt('cité')] }),
      block(7, 'code', { rich_text: [rt('let x = 1')], language: 'javascript' }),
      block(8, 'divider'),
    ], ctx)
    expect(types(doc.content)).toEqual(['heading', 'bulletList', 'taskList', 'blockquote', 'codeBlock', 'horizontalRule'])
    const list = doc.content![1]
    expect(list.content).toHaveLength(2)
    expect(types(list.content![0].content)).toEqual(['paragraph', 'bulletList'])
    expect(doc.content![2].content![0].attrs).toEqual({ checked: true })
    expect(doc.content![4].attrs).toEqual({ language: 'javascript' })
  })

  it('garde encadre, repliable, image, tableau ; aplatit les colonnes', () => {
    const { doc } = notionBlocksToPage([
      block(1, 'callout', { rich_text: [rt('Attention')], icon: { type: 'emoji', emoji: '⚠️' }, color: 'red_background' }),
      block(2, 'heading_2', { rich_text: [rt('Plus')], is_toggleable: true }, [block(3, 'paragraph', { rich_text: [rt('caché')] })]),
      block(4, 'toggle', { rich_text: [rt('Détails')] }),
      block(9, 'image', { type: 'file', file: { url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/x/photo.png' }, caption: [rt('Une photo')] }),
      block(10, 'image', { type: 'external', external: { url: 'https://example.org/a.png' }, caption: [] }),
      block(11, 'table', { table_width: 2, has_column_header: true }, [
        block(12, 'table_row', { cells: [[rt('Nom')], [rt('Prix')]] }),
        block(13, 'table_row', { cells: [[rt('Logo')], [rt('300')]] }),
      ]),
      block(14, 'column_list', {}, [
        block(15, 'column', {}, [block(16, 'paragraph', { rich_text: [rt('gauche')] })]),
        block(17, 'column', {}, [block(18, 'paragraph', { rich_text: [rt('droite')] })]),
      ]),
    ], ctx)
    expect(types(doc.content)).toEqual(['callout', 'toggle', 'toggle', 'image', 'image', 'table', 'paragraph', 'paragraph'])
    expect(doc.content![0].attrs).toEqual({ icon: '⚠️', color: 'red' })
    expect(doc.content![1].attrs).toEqual({ heading: 2 })
    expect(types(doc.content![1].content)).toEqual(['toggleTitle', 'paragraph'])
    expect(doc.content![3].attrs).toEqual({ src: 'Espace/Accueil/photo.png', alt: 'Une photo' })
    expect(doc.content![4].attrs).toEqual({ src: 'https://example.org/a.png', alt: '' })
    const header = doc.content![5].content![0].content![0]
    expect(header.attrs).toEqual({ header: true })
    expect(doc.content![5].content![1].content![0].attrs).toEqual({ header: false })
  })

  it('les liens et mentions vers des pages importees visent le vault ; les autres restent', () => {
    const { doc } = notionBlocksToPage([
      block(1, 'paragraph', {
        rich_text: [
          rt('voir ', {}),
          { type: 'mention', plain_text: 'Projet', mention: { type: 'page', page: { id: '00000000-0000-0000-0000-0000000001f4' } }, annotations: {} },
          rt(' et ', {}),
          rt('ce lien', { text: { content: 'ce lien', link: { url: `/${ID(600)}` } } }),
          rt(' ou ', {}),
          rt('ailleurs', { text: { content: 'ailleurs', link: { url: `https://www.notion.so/Autre-${ID(777)}` } } }),
          rt('surligné', { annotations: { bold: true, color: 'yellow_background' } }),
          rt('ligne1\nligne2'),
        ],
      }),
      block(2, 'child_page', { title: 'Projet' }),
    ], { ...ctx, linkTarget: (id: string) => (id === ID(500) ? 'Espace/Projet' : id === ID(600) ? 'Espace/Tâches.base' : id === ID(2) ? 'Espace/Accueil/Projet' : null) })
    const inline = doc.content![0].content!
    const href = (text: string) => inline.find(n => n.text === text)?.marks?.find(m => m.type === 'link')?.attrs?.href
    expect(href('Projet')).toBe('Espace/Projet')
    expect(href('ce lien')).toBe('Espace/Tâches.base')
    expect(href('ailleurs')).toBe(`https://www.notion.so/Autre-${ID(777)}`)
    expect(inline.find(n => n.text === 'surligné')?.marks).toEqual([{ type: 'bold' }, { type: 'highlight', attrs: { color: 'yellow' } }])
    expect(types(inline).slice(-3)).toEqual(['text', 'hardBreak', 'text'])
    expect(doc.content![1]).toEqual({ type: 'pageLink', attrs: { target: 'Espace/Accueil/Projet' } })
  })

  it('compte les blocs non importes et les signale dans la page', () => {
    const { doc, unsupported } = notionBlocksToPage([block(1, 'ai_block'), block(2, 'table_of_contents'), block(3, 'ai_block')], ctx)
    expect(unsupported).toEqual({ ai_block: 2 })
    expect(doc.content).toHaveLength(2)
    expect(doc.content![0].content![0].text).toContain('ai_block')
  })

  it('une page vide garde un paragraphe', () => {
    expect(notionBlocksToPage([], ctx).doc).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
  })

  it('reconnait les adresses de pages Notion', () => {
    expect(notionIdFromUrl(`/${ID(5)}`)).toBe(ID(5))
    expect(notionIdFromUrl(`https://www.notion.so/team/Ma-page-${ID(5)}?pvs=4`)).toBe(ID(5))
    expect(notionIdFromUrl('https://example.org/page')).toBeNull()
  })
})

describe('Notion -> base', () => {
  const schema = {
    Nom: { id: 'title', name: 'Nom', type: 'title', title: {} },
    Statut: {
      id: 'a%3Ab', name: 'Statut', type: 'status',
      status: {
        options: [{ id: 'o1', name: 'Fait', color: 'green' }, { id: 'o2', name: 'À faire', color: 'default' }],
        groups: [{ name: 'To-do', option_ids: ['o2'] }, { name: 'In progress', option_ids: [] }, { name: 'Complete', option_ids: ['o1'] }],
      },
    },
    Prix: { id: 'p1', name: 'Prix', type: 'number', number: { format: 'euro' } },
    Site: { id: 'u1', name: 'Site', type: 'url', url: {} },
    Num: { id: 'n1', name: 'Num', type: 'unique_id', unique_id: { prefix: 'T' } },
    Tags: { id: 't1', name: 'Tags', type: 'multi_select', multi_select: { options: [{ name: 'web', color: 'pink' }] } },
    Échéance: { id: 'd1', name: 'Échéance', type: 'date', date: {} },
    Lié: { id: 'r1', name: 'Lié', type: 'relation', relation: { data_source_id: ID(77), dual_property: { synced_property_name: 'Tâches' } } },
  }

  it('lit les valeurs des proprietes', () => {
    const c = { linkTarget: (id: string) => (id === ID(500) ? 'Espace/Projet' : null) }
    expect(propertyValueOf({ type: 'status', status: { name: 'Fait' } }, c)).toBe('Fait')
    expect(propertyValueOf({ type: 'multi_select', multi_select: [{ name: 'a' }, { name: 'b' }] }, c)).toEqual(['a', 'b'])
    expect(propertyValueOf({ type: 'date', date: { start: '2026-11-23' } }, c)).toBe('2026-11-23')
    expect(propertyValueOf({ type: 'checkbox', checkbox: false }, c)).toBe(false)
    expect(propertyValueOf({ type: 'relation', relation: [{ id: ID(500) }, { id: ID(9) }] }, c)).toEqual(['[[Espace/Projet]]'])
    expect(propertyValueOf({ type: 'formula', formula: { type: 'number', number: 42 } }, c)).toBe(42)
    // Le numero seul : le prefixe est dans le type (PropertyDef.prefix).
    expect(propertyValueOf({ type: 'unique_id', unique_id: { prefix: 'T', number: 7 } }, c)).toBe(7)
    expect(propertyValueOf({ type: 'rich_text', rich_text: [] }, c)).toBeUndefined()
  })

  it('declare les types et les couleurs des choix', () => {
    const defs = propertyDefs(schema, { baseOf: id => (id === ID(77) ? 'doc-projets' : undefined) })
    expect(defs.find(d => d.key === 'Statut')).toEqual({ key: 'Statut', type: 'status', options: [{ value: 'Fait', color: 'green', group: 'done' }, { value: 'À faire', group: 'todo' }] })
    expect(defs.find(d => d.key === 'Tags')).toEqual({ key: 'Tags', type: 'multiselect', options: [{ value: 'web', color: 'pink' }] })
    expect(defs.find(d => d.key === 'Prix')).toEqual({ key: 'Prix', type: 'number', format: 'euro' })
    expect(defs.find(d => d.key === 'Site')).toEqual({ key: 'Site', type: 'url' })
    expect(defs.find(d => d.key === 'Num')).toEqual({ key: 'Num', type: 'id', prefix: 'T' })
    expect(defs.find(d => d.key === 'Lié')).toEqual({ key: 'Lié', type: 'relation', relation: { base: 'doc-projets', back: 'Tâches' } })
    expect(defs.find(d => d.key === 'Nom')).toBeUndefined()
  })

  it('reprend colonnes et vues : kanban, filtres simples, tris, colonnes masquees', () => {
    const m = baseManifestOf('Tâches', schema, [
      {
        id: 'v-1', name: 'Tout', type: 'table',
        filter: { and: [{ property: 'Statut', status: { equals: 'Fait' } }, { property: 'Prix', number: { greater_than: 100 } }] },
        sorts: [{ property: 'Prix', direction: 'descending' }],
        configuration: { properties: [{ property_id: 'p1', visible: true, width: 220 }, { property_id: 'a:b', visible: true }, { property_id: 't1', visible: false }] },
      },
      { id: 'v-2', name: 'Par statut', type: 'board', configuration: { group_by: { property_id: 'a%3Ab' } } },
      { id: 'v-3', name: 'Agenda', type: 'calendar', filter: { or: [{ property: 'Prix', number: { equals: 1 } }, { property: 'Prix', number: { equals: 2 } }] } },
      {
        id: 'v-4', name: 'Cette semaine', type: 'gallery',
        filter: { and: [{ property: 'Échéance', date: { this_week: {} } }, { or: [{ property: 'Tags', multi_select: { contains: 'web' } }, { property: 'Tags', multi_select: { is_empty: true } }] }] },
      },
      { id: 'v-5', name: 'Bizarre', type: 'map' },
    ])
    expect(m.columns.map(c => c.key)).toEqual(['Prix', 'Statut', 'Tags', 'Site', 'Num', 'Échéance', 'Lié'])
    expect(m.columns[0].width).toBe(220)
    const [all, board, agenda, week, odd] = m.views
    expect(all.filters).toEqual([{ key: 'Statut', op: 'eq', value: 'Fait' }, { key: 'Prix', op: 'gt', value: 100 }])
    expect(all.sorts).toEqual([{ key: 'Prix', dir: 'desc' }])
    expect(all.hidden).toEqual(['Tags'])
    expect(board).toMatchObject({ type: 'kanban', groupBy: 'Statut', name: 'Par statut' })
    // Calendrier sur la premiere date, filtre « ou » repris.
    expect(agenda).toMatchObject({ type: 'calendar', dateBy: 'Échéance', filterMode: 'or', filters: [{ key: 'Prix', op: 'eq', value: 1 }, { key: 'Prix', op: 'eq', value: 2 }] })
    // Groupe imbrique et date relative.
    expect(week).toMatchObject({ type: 'gallery', filterMode: 'and', filters: [
      { key: 'Échéance', op: 'within', value: '@thisWeek' },
      { mode: 'or', items: [{ key: 'Tags', op: 'contains', value: 'web' }, { key: 'Tags', op: 'empty' }] },
    ] })
    // Une disposition inconnue devient un tableau, et le rapport le dit.
    expect(odd.type).toBe('table')
    expect(m.warnings).toHaveLength(1)
  })
})

describe('NotionClient', () => {
  it('espace les appels, attend le Retry-After d\'un 429, suit la pagination', async () => {
    let clock = 0
    const sleeps: number[] = []
    const calls: string[] = []
    const replies: NotionHttpReply[] = [
      { status: 429, retryAfter: 2, body: '{}' },
      { status: 200, body: JSON.stringify({ results: [{ id: 'a' }], has_more: true, next_cursor: 'c2' }) },
      { status: 200, body: JSON.stringify({ results: [{ id: 'b' }], has_more: false }) },
    ]
    const port: NotionApiPort = { request: async (m, p, b) => { calls.push(`${m} ${p} ${JSON.stringify(b ?? null)}`); return replies.shift()! } }
    const client = new NotionClient(port, { intervalMs: 350, sleep: async ms => { sleeps.push(ms); clock += ms }, now: () => clock })
    const all = await client.search()
    expect(all.map(r => r.id)).toEqual(['a', 'b'])
    expect(sleeps).toContain(2000)
    expect(calls[2]).toContain('"start_cursor":"c2"')
    expect(sleeps.filter(ms => ms > 0 && ms <= 350).length).toBeGreaterThan(0)
  })

  it('une erreur de Notion garde son message', async () => {
    const client = new NotionClient({ request: async () => ({ status: 404, body: JSON.stringify({ code: 'object_not_found', message: 'Introuvable' }) }) }, { sleep: async () => {} })
    await expect(client.blockChildren(ID(1))).rejects.toMatchObject({ status: 404, code: 'object_not_found', message: 'Introuvable' })
  })
})

// ── Import progressif ──────────────────────────────────────────────────────

function fakeNotion() {
  const page = (id: number, title: string, parent: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    object: 'page', id: ID(id), parent, properties: { title: { type: 'title', title: [rt(title)] }, ...extra },
  })
  const search = [
    page(1, 'Accueil', { type: 'workspace', workspace: true }),
    page(2, 'Projet', { type: 'page_id', page_id: ID(1) }),
    { object: 'data_source', id: ID(10), title: [rt('Tâches')], parent: { type: 'database_id', database_id: ID(11) }, database_parent: { type: 'page_id', page_id: ID(1) } },
  ]
  const rows = [
    page(20, 'Logo', { type: 'data_source_id', data_source_id: ID(10), database_id: ID(11) }, {
      Statut: { type: 'status', status: { name: 'Fait' } },
      Lié: { type: 'relation', relation: [{ id: ID(2) }] },
    }),
  ]
  const children: Record<string, NotionBlock[]> = {
    [ID(1)]: [
      block(100, 'paragraph', { rich_text: [rt('Bienvenue')] }),
      block(2, 'child_page', { title: 'Projet' }),
      block(11, 'child_database', { title: 'Tâches' }),
      block(101, 'image', { type: 'file', file: { url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/x/logo.png' }, caption: [] }),
    ],
    [ID(2)]: [block(200, 'paragraph', { rich_text: [rt('Le projet')] })],
    [ID(20)]: [block(300, 'paragraph', { rich_text: [rt('Détails du logo')] })],
  }
  const calls: string[] = []
  const port: NotionApiPort = {
    async request(method, path) {
      calls.push(`${method} ${path}`)
      const ok = (v: unknown): NotionHttpReply => ({ status: 200, body: JSON.stringify(v) })
      if (path === '/v1/search') return ok({ results: search, has_more: false })
      if (path === `/v1/data_sources/${ID(10)}/query`) return ok({ results: rows, has_more: false })
      if (path === `/v1/data_sources/${ID(10)}`) {
        return ok({ id: ID(10), properties: {
          Nom: { id: 'title', name: 'Nom', type: 'title' },
          Statut: { id: 's', name: 'Statut', type: 'status', status: { options: [{ name: 'Fait', color: 'green' }] } },
          Lié: { id: 'r', name: 'Lié', type: 'relation' },
        } })
      }
      if (path.startsWith('/v1/views?')) return ok({ results: [{ id: 'v1' }], has_more: false })
      if (path === '/v1/views/v1') return ok({ id: 'v1', name: 'Kanban', type: 'board', configuration: { group_by: { property_id: 's' } } })
      const m = /^\/v1\/blocks\/([0-9a-f]+)\/children/.exec(path)
      if (m) return ok({ results: children[m[1]] ?? [], has_more: false })
      return { status: 404, body: JSON.stringify({ code: 'object_not_found', message: path }) }
    },
  }
  return { port, calls }
}

function memoryTarget() {
  const docs = new Map<string, { id: string; text?: string; page?: PageNode; base?: unknown }>()
  const folders = new Set<string>()
  const files = new Map<string, Uint8Array>()
  const props: unknown[] = []
  let failPage: string | null = null
  const byId = (id: string) => [...docs.values()].find(d => d.id === id)!
  const target: NotionImportTarget = {
    exists: p => docs.has(p) || folders.has(p) || files.has(p),
    async createFolder(p) { folders.add(p) },
    async createDocument(p) { const id = `doc-${docs.size + 1}`; docs.set(p, { id }); return id },
    async writePage(id, doc) {
      if (failPage && JSON.stringify(doc).includes(failPage)) throw new Error('disque plein')
      byId(id).page = doc
    },
    async writeNote(id, text) { byId(id).text = text },
    async writeBase(id, manifest, folder) { byId(id).base = { manifest, folder } },
    async writeAttachment(notePath, name, bytes) {
      const p = `${notePath.replace(/\.[a-z]+$/, '')}/${name}`
      files.set(p, bytes)
      return p
    },
    declareProperties(defs) { props.push(...defs) },
    pageToMarkdown: doc => (doc.content ?? []).map(n => (n.content ?? []).map(t => t.text ?? '').join('')).join('\n\n') + '\n',
  }
  return { target, docs, folders, files, props, failOn: (text: string | null) => { failPage = text } }
}

function memoryStore() {
  let state: NotionImportState | null = null
  return { store: { load: async () => (state ? JSON.parse(JSON.stringify(state)) : null), save: async (s: NotionImportState) => { state = JSON.parse(JSON.stringify(s)) } }, get: () => state }
}

describe('NotionImportJob', () => {
  it('pose le squelette, puis remplit pages, base et lignes', async () => {
    const { port } = fakeNotion()
    const t = memoryTarget()
    const s = memoryStore()
    const client = new NotionClient(port, { intervalMs: 0, sleep: async () => {} })
    const job = new NotionImportJob(client, { download: async () => new Uint8Array([1, 2]) }, t.target, s.store)
    const phases = new Set<string>()
    job.onProgress(p => phases.add(p.phase))
    const report = await job.run({ root: 'Mon Notion', workspace: 'Mon Notion' })

    expect([...t.docs.keys()].sort()).toEqual([
      'Mon Notion/Accueil.page', 'Mon Notion/Accueil/Projet.page', 'Mon Notion/Accueil/Tâches.base', 'Mon Notion/Accueil/Tâches/Logo.md',
    ])
    expect(t.folders.has('Mon Notion/Accueil/Tâches')).toBe(true)
    const home = t.docs.get('Mon Notion/Accueil.page')!.page!
    expect(home.content!.map(n => n.type)).toEqual(['paragraph', 'pageLink', 'pageLink', 'image'])
    expect(home.content![1].attrs).toEqual({ target: 'Mon Notion/Accueil/Projet' })
    expect(home.content![2].attrs).toEqual({ target: 'Mon Notion/Accueil/Tâches.base' })
    expect(home.content![3].attrs).toEqual({ src: 'Mon Notion/Accueil/logo.png', alt: '' })
    expect(t.files.has('Mon Notion/Accueil/logo.png')).toBe(true)
    expect(t.docs.get('Mon Notion/Accueil/Tâches/Logo.md')!.text).toBe('---\nStatut: Fait\nLié: ["[[Mon Notion/Accueil/Projet]]"]\n---\nDétails du logo\n')
    const base = t.docs.get('Mon Notion/Accueil/Tâches.base')!.base as { manifest: { views: { type: string; groupBy: string }[] }; folder: string }
    expect(base.folder).toBe('Mon Notion/Accueil/Tâches')
    expect(base.manifest.views[0]).toMatchObject({ type: 'kanban', groupBy: 'Statut' })
    expect(t.props).toContainEqual({ key: 'Statut', type: 'status', options: [{ value: 'Fait', color: 'green', group: 'todo' }] })
    expect(report).toMatchObject({ pages: 2, bases: 1, rows: 1, files: 1, failed: [] })
    expect([...phases]).toEqual(['plan', 'skeleton', 'fill', 'done'])
    expect(s.get()!.finishedAt).toBeTruthy()
  })

  it('reprend un import arrete, et retente ce qui a echoue', async () => {
    const { port, calls } = fakeNotion()
    const t = memoryTarget()
    const s = memoryStore()
    const client = new NotionClient(port, { intervalMs: 0, sleep: async () => {} })
    const files = { download: async () => new Uint8Array([1]) }
    t.failOn('Le projet')
    const first = new NotionImportJob(client, files, t.target, s.store)
    const r1 = await first.run({ root: 'N', workspace: 'N' })
    expect(r1.failed).toEqual([{ title: 'Projet', error: 'disque plein' }])
    expect(s.get()!.finishedAt).toBeUndefined()

    t.failOn(null)
    calls.length = 0
    const second = new NotionImportJob(client, files, t.target, s.store)
    const r2 = await second.run()
    expect(r2.failed).toEqual([])
    expect(r2.pages).toBe(2)
    // Pas de nouveau plan : seule la page en echec est relue.
    expect(calls).toEqual([`GET /v1/blocks/${ID(2)}/children?page_size=100`])
    expect(t.docs.get('N/Accueil/Projet.page')!.page!.content![0].content![0].text).toBe('Le projet')
    expect(s.get()!.finishedAt).toBeTruthy()
  })
})
