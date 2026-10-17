// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// plugin-page : l'adaptateur entre le Y.Doc prive de l'editeur et le
// stockage (arbre partage, ou fichier JSON en mode local).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemorySharedTree } from '@savoire/plugin-runtime'
import type { TreeChangeInfo, TreeElementInit, VaultAPI } from '@savoire/plugin-api'
import {
  createPageDoc, fragmentToPm, insertInitsIntoY, pmToInit, replaceFragment,
  TreeMirror, VaultMirror, PageFileError, stringifyPageFile, type PmJson,
} from '@savoire/plugin-page/adapter'
import {
  pageToMarkdown, pageFileToMarkdown, filterBlocks, matchSlash,
  subPagePath, linkTargetOf, resolveLinkTarget,
} from '@savoire/plugin-page'

const DOC: PmJson = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Projet' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Du ' },
        { type: 'text', text: 'gras', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' et un ' },
        { type: 'text', text: 'lien', marks: [{ type: 'link', attrs: { href: 'https://example.org' } }] },
      ],
    },
    {
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'fait' }] }] },
        { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a faire' }] }] },
      ],
    },
    { type: 'pageLink', attrs: { target: 'Projet/Notes' } },
    { type: 'horizontalRule' },
  ],
}

/** Un membre : son Y.Doc prive, son arbre, le miroir entre les deux. */
function member(tree = new InMemorySharedTree()) {
  const { doc, fragment } = createPageDoc()
  const mirror = new TreeMirror(fragment, tree)
  return { doc, fragment, tree, mirror }
}

/** Geste local dans le Y.Doc (ce que ferait y-prosemirror). */
const LOCAL = { editor: true }

function firstText(fragment: ReturnType<typeof createPageDoc>['fragment'], block: number) {
  const el = fragment.get(block) as unknown as { get(i: number): { insert(i: number, s: string, a?: object): void; format(i: number, n: number, a: object): void; toString(): string } }
  return el.get(0)
}

describe('plugin-page — conversions', () => {
  it('JSON ProseMirror -> Y.Doc -> JSON : identique, marques comprises', () => {
    const { doc, fragment } = createPageDoc()
    doc.transact(() => replaceFragment(fragment, pmToInit(DOC)))
    expect(fragmentToPm(fragment)).toEqual(DOC)
  })

  it('une marque sans attribut vaut true dans l\'arbre', () => {
    const init = pmToInit(DOC)
    const para = init.children![1] as TreeElementInit
    expect(para.children).toEqual([{
      kind: 'text',
      delta: [
        { insert: 'Du ' },
        { insert: 'gras', attributes: { bold: true } },
        { insert: ' et un ' },
        { insert: 'lien', attributes: { link: { href: 'https://example.org' } } },
      ],
    }])
  })
})

describe('plugin-page — miroir Y.Doc <-> arbre partage', () => {
  it('l\'ouverture lit l\'arbre sans y ecrire', () => {
    const tree = new InMemorySharedTree()
    tree.root.set('doc', pmToInit(DOC))
    const writes: TreeChangeInfo[] = []
    tree.onChange((_c, info) => writes.push(info))
    const a = member(tree)
    a.mirror.attach()
    expect(fragmentToPm(a.fragment)).toEqual(DOC)
    expect(writes).toEqual([])
  })

  it('une page vide ouverte puis fermee n\'ecrit rien', () => {
    const a = member()
    const writes: TreeChangeInfo[] = []
    a.tree.onChange((_c, info) => writes.push(info))
    a.mirror.attach()
    a.mirror.detach()
    expect(a.tree.root.has('doc')).toBe(false)
    expect(writes).toEqual([])
  })

  it('un geste local devient une operation fine de l\'arbre, sans echo', () => {
    const tree = new InMemorySharedTree()
    tree.root.set('doc', pmToInit(DOC))
    const a = member(tree)
    a.mirror.attach()
    const changes: { kinds: string[]; info: TreeChangeInfo }[] = []
    tree.onChange((c, info) => changes.push({ kinds: c.map(x => x.kind), info }))
    const ydocUpdates: unknown[] = []
    a.doc.on('update', (_u: Uint8Array, origin: unknown) => ydocUpdates.push(origin))

    a.doc.transact(() => firstText(a.fragment, 0).insert(6, ' X'), LOCAL)

    // Un seul lot, un changement de texte (pas de reecriture du document).
    expect(changes).toHaveLength(1)
    expect(changes[0].kinds).toEqual(['text'])
    expect(changes[0].info.origin).toBe('local')
    // Le Y.Doc n'a recu que le geste lui-meme : pas d'echo depuis l'arbre.
    expect(ydocUpdates).toEqual([LOCAL])
    const doc = tree.root.get('doc') as { toJSON(): unknown }
    expect(JSON.stringify(doc.toJSON())).toContain('Projet X')
  })

  it('premiere frappe dans une page vide : l\'element doc est cree', () => {
    const a = member()
    a.mirror.attach()
    a.doc.transact(() => insertInitsIntoY(a.fragment, 0, [
      { kind: 'element', name: 'paragraph', children: [{ kind: 'text', delta: [{ insert: 'Bonjour' }] }] },
    ]), LOCAL)
    const doc = a.tree.root.get('doc') as { kind: string; length: number }
    expect(doc.kind).toBe('element')
    expect(doc.length).toBe(1)
  })

  it('deux membres relies convergent, dans les deux sens', () => {
    const ta = new InMemorySharedTree()
    const tb = new InMemorySharedTree()
    InMemorySharedTree.link(ta, tb)
    const a = member(ta)
    const b = member(tb)
    a.mirror.attach()
    b.mirror.attach()

    // A pose le contenu : il arrive chez B en lot distant, apres l'ouverture.
    a.doc.transact(() => replaceFragment(a.fragment, pmToInit(DOC)), LOCAL)
    expect(fragmentToPm(b.fragment)).toEqual(DOC)

    // B tape dans le titre et met un mot en italique.
    b.doc.transact(() => {
      firstText(b.fragment, 0).insert(0, 'Mon ')
      firstText(b.fragment, 1).format(0, 2, { italic: {} })
    }, LOCAL)
    // A change le niveau du titre et ajoute un paragraphe a la fin.
    a.doc.transact(() => {
      (a.fragment.get(0) as unknown as { setAttribute(k: string, v: unknown): void }).setAttribute('level', 2)
      insertInitsIntoY(a.fragment, a.fragment.length, [
        { kind: 'element', name: 'paragraph', children: [{ kind: 'text', delta: [{ insert: 'Fin' }] }] },
      ])
    }, LOCAL)
    // B supprime le separateur.
    b.doc.transact(() => b.fragment.delete(4, 1), LOCAL)

    const pa = fragmentToPm(a.fragment)
    expect(pa).toEqual(fragmentToPm(b.fragment))
    expect(pa.content![0]).toEqual({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Mon Projet' }] })
    expect(pa.content![1].content![0]).toEqual({ type: 'text', text: 'Du', marks: [{ type: 'italic' }] })
    expect(pa.content!.map((n: { type?: string }) => n.type)).toEqual(['heading', 'paragraph', 'taskList', 'pageLink', 'paragraph'])
  })

  it('un changement distant n\'est pas renvoye dans l\'arbre', () => {
    const ta = new InMemorySharedTree()
    const tb = new InMemorySharedTree()
    InMemorySharedTree.link(ta, tb)
    const a = member(ta)
    const b = member(tb)
    a.mirror.attach()
    b.mirror.attach()
    a.doc.transact(() => replaceFragment(a.fragment, pmToInit(DOC)), LOCAL)
    const localOnB: TreeChangeInfo[] = []
    tb.onChange((_c, info) => { if (info.origin === 'local') localOnB.push(info) })
    a.doc.transact(() => firstText(a.fragment, 0).insert(0, '!'), LOCAL)
    expect(firstText(b.fragment, 0).toString()).toBe('!Projet')
    expect(localOnB).toEqual([])
  })
})

describe('plugin-page — mode local (fichier JSON via le vault)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function fakeVault(content: string) {
    const writes: string[] = []
    const vault = {
      readDocumentByPath: async () => content,
      resolveDocumentId: (p: string) => `id:${p}`,
      write: async (_id: string, c: string) => { writes.push(c) },
    } as unknown as VaultAPI
    return { vault, writes }
  }

  it('ouvrir n\'ecrit jamais, meme un fichier formate autrement', async () => {
    // Meme contenu, autre mise en forme JSON : rien a ecrire.
    const raw = JSON.stringify({ format: 'savoire-page', version: 1, doc: DOC })
    const { vault, writes } = fakeVault(raw)
    const { fragment } = createPageDoc()
    const m = new VaultMirror(fragment, vault, 'Projet.page', { debounceMs: 100 })
    await m.load()
    expect(fragmentToPm(fragment)).toEqual(DOC)
    await vi.advanceTimersByTimeAsync(1000)
    await m.destroy()
    expect(writes).toEqual([])
  })

  it('une modification est ecrite une fois, apres l\'anti-rebond', async () => {
    const { vault, writes } = fakeVault('')
    const { doc, fragment } = createPageDoc()
    const onSaved = vi.fn()
    const m = new VaultMirror(fragment, vault, 'P.page', { debounceMs: 100, onSaved })
    await m.load()
    doc.transact(() => insertInitsIntoY(fragment, 0, [
      { kind: 'element', name: 'paragraph', children: [{ kind: 'text', delta: [{ insert: 'a' }] }] },
    ]), LOCAL)
    doc.transact(() => firstText(fragment, 0).insert(1, 'b'), LOCAL)
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(150)
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0]).doc).toEqual({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ab' }] }] })
    expect(onSaved).toHaveBeenCalledWith(writes[0])
    await m.destroy()
  })

  it('fermer la vue ecrit ce qui attend', async () => {
    const { vault, writes } = fakeVault('')
    const { doc, fragment } = createPageDoc()
    const m = new VaultMirror(fragment, vault, 'P.page', { debounceMs: 10_000 })
    await m.load()
    doc.transact(() => insertInitsIntoY(fragment, 0, [{ kind: 'element', name: 'horizontalRule', children: [] }]), LOCAL)
    await m.destroy()
    expect(writes).toHaveLength(1)
  })

  it('un fichier illisible leve PageFileError et n\'est pas ecrase', async () => {
    const { vault, writes } = fakeVault('# du markdown')
    const { fragment } = createPageDoc()
    const m = new VaultMirror(fragment, vault, 'P.page')
    await expect(m.load()).rejects.toBeInstanceOf(PageFileError)
    expect(writes).toEqual([])
  })
})

describe('plugin-page — export Markdown, sous-pages, menu /', () => {
  it('exporte la page en Markdown pour l\'index, liens de sous-page compris', () => {
    expect(pageToMarkdown(DOC)).toBe(
      '# Projet\n\nDu **gras** et un [lien](https://example.org)\n\n- [x] fait\n- [ ] a faire\n\n[[Projet/Notes]]\n\n---\n',
    )
    expect(pageFileToMarkdown(stringifyPageFile(DOC))).toBe(pageToMarkdown(DOC))
    expect(pageFileToMarkdown('pas du json')).toBe('')
    expect(pageFileToMarkdown('')).toBe('')
  })

  it('range les sous-pages dans le dossier frere, sans collision', () => {
    const existing = new Set(['A/Projet/Notes.page'])
    expect(subPagePath('A/Projet.page', 'Notes', existing)).toBe('A/Projet/Notes 2.page')
    expect(subPagePath('Projet.page', ' Idées / brutes ', new Set())).toBe('Projet/Idées brutes.page')
    expect(subPagePath('Projet.page', '', new Set())).toBe('Projet/Sans titre.page')
    expect(linkTargetOf('A/Projet/Notes.page')).toBe('A/Projet/Notes')
  })

  it('resout un lien : page, sinon note Markdown', () => {
    const files = new Set(['Projet/Notes.page', 'Journal.md'])
    const exists = (p: string) => files.has(p)
    expect(resolveLinkTarget('Projet/Notes', exists)).toBe('Projet/Notes.page')
    expect(resolveLinkTarget('Journal', exists)).toBe('Journal.md')
    expect(resolveLinkTarget('Nouveau', exists)).toBe('Nouveau.page')
  })

  it('ouvre le menu sur « / » en debut de bloc ou apres une espace', () => {
    expect(matchSlash('/')).toEqual({ offset: 0, query: '' })
    expect(matchSlash('du texte /tit')).toEqual({ offset: 9, query: 'tit' })
    expect(matchSlash('a/b')).toBeNull()
    expect(matchSlash('/titre 1')).toBeNull()
    expect(filterBlocks('titre').map(b => b.id)).toEqual(['h1', 'h2', 'h3'])
    expect(filterBlocks('tache').map(b => b.id)).toEqual(['task'])
    expect(filterBlocks('sous').map(b => b.id)).toEqual(['subpage'])
  })
})

describe('plugin-page — surlignage dans l\'arbre et en Markdown', () => {
  const HL: PmJson = {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [
        { type: 'text', text: 'jaune', marks: [{ type: 'highlight', attrs: { color: null } }] },
        { type: 'text', text: ' et ' },
        { type: 'text', text: 'rouge', marks: [{ type: 'bold' }, { type: 'highlight', attrs: { color: 'red' } }] },
      ],
    }],
  }

  it('une marque highlight devient un attribut de format : true sans couleur, { color } sinon', () => {
    const para = pmToInit(HL).children![0] as TreeElementInit
    expect(para.children).toEqual([{
      kind: 'text',
      delta: [
        { insert: 'jaune', attributes: { highlight: true } },
        { insert: ' et ' },
        { insert: 'rouge', attributes: { bold: true, highlight: { color: 'red' } } },
      ],
    }])
  })

  it('aller-retour JSON -> Y.Doc -> arbre -> JSON : la couleur est gardee', () => {
    const { doc, fragment } = createPageDoc()
    doc.transact(() => replaceFragment(fragment, pmToInit(HL)))
    const back = fragmentToPm(fragment)
    const texts = (back.content![0].content ?? []) as PmJson[]
    expect(texts[0].marks).toEqual([{ type: 'highlight' }])
    expect(texts[2].marks).toEqual([{ type: 'bold' }, { type: 'highlight', attrs: { color: 'red' } }])
  })

  it('un surlignage pose dans le Y.Doc arrive dans l\'arbre, sans attribut null', () => {
    const tree = new InMemorySharedTree()
    tree.root.set('doc', pmToInit(DOC))
    const a = member(tree)
    a.mirror.attach()
    // Ce qu'ecrit y-prosemirror pour une marque { color: null } puis { color: 'blue' }.
    a.doc.transact(() => firstText(a.fragment, 0).format(0, 2, { highlight: { color: null } }), LOCAL)
    a.doc.transact(() => firstText(a.fragment, 0).format(2, 2, { highlight: { color: 'blue' } }), LOCAL)
    type El = { get(i: number): El; toDelta(): unknown }
    const heading = (tree.root.get('doc') as unknown as El).get(0)
    expect(heading.get(0).toDelta()).toEqual([
      { insert: 'Pr', attributes: { highlight: true } },
      { insert: 'oj', attributes: { highlight: { color: 'blue' } } },
      { insert: 'et' },
    ])
    a.mirror.detach()
  })

  it('exporte ==texte== et ==🔴texte==, comme Obsidian et Plume', () => {
    expect(pageToMarkdown(HL)).toBe('==jaune== et ==🔴**rouge**==\n')
    const unknown: PmJson = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'x', marks: [{ type: 'highlight', attrs: { color: 'rose' } }] },
    ] }] }
    expect(pageToMarkdown(unknown)).toBe('==x==\n')
  })
})
