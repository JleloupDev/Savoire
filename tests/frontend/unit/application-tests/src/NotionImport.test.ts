// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Import d'un export Notion (Markdown & CSV) : noms sans identifiants, notes
// de dossier, bases avec leurs valeurs en frontmatter, liens [[...]].
import { describe, it, expect } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { convertNotionExport, parseCsv, readZip, stripId, columnKind, type ArchiveFile } from '@savoire/application'

const ID1 = '0123456789abcdef0123456789abcdef'
const ID2 = 'fedcba9876543210fedcba9876543210'
const ID3 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ID4 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const ID5 = 'cccccccccccccccccccccccccccccccc'
const enc = new TextEncoder()
const dec = new TextDecoder()
const f = (path: string, text: string): ArchiveFile => ({ path, bytes: enc.encode(text) })

function exportFiles(): ArchiveFile[] {
  return [
    f(`Accueil ${ID1}.md`, `# Accueil\n\nVoir [Projets](Accueil%20${ID1}/Projets%20${ID2}.csv), [Note](Accueil%20${ID1}/Note%20${ID3}.md) et [le site](https://example.org).\n\n![](Accueil%20${ID1}/logo.png)\n\n[Disparue](Autre%20${ID5}.md)\n`),
    { path: `Accueil ${ID1}/logo.png`, bytes: new Uint8Array([1, 2, 3]) },
    f(`Accueil ${ID1}/Note ${ID3}.md`, '# Note\n\nRetour à [Accueil](../Accueil%20' + ID1 + '.md).\n'),
    f(`Accueil ${ID1}/Projets ${ID2}.csv`, '﻿Name,Statut,Prix,Fait,Échéance,Tags\nLogo,En cours,300,No,"October 5, 2026","design, print"\nSite web,Fini,1200,Yes,"November 8, 2026",web\nSans page,À faire,,No,,\n'),
    f(`Accueil ${ID1}/Projets ${ID2}_all.csv`, '﻿Name,Statut,Prix,Fait,Échéance,Tags\nLogo,En cours,300,No,"October 5, 2026","design, print"\nSite web,Fini,1200,Yes,"November 8, 2026",web\nSans page,À faire,,No,,\nArchivé,Fini,10,Yes,,\n'),
    f(`Accueil ${ID1}/Projets ${ID2}/Logo ${ID4}.md`, '# Logo\n\nStatut: En cours\nPrix: 300\nFait: No\nÉchéance: October 5, 2026\nTags: design, print\n\nLe logo du projet.\n'),
    f(`Accueil ${ID1}/Projets ${ID2}/Site web ${ID5}.md`, '# Site web\n\nStatut: Fini\n\nContenu.\n'),
    f(`Accueil ${ID1}/Projets ${ID2}/Archivé ${ID3}.md`, '# Archivé\n'),
    // Homonyme : deux pages « Note » dans le meme dossier.
    f(`Accueil ${ID1}/Note ${ID4}.md`, '# Note\n\nUne autre.\n'),
    { path: '__MACOSX/x', bytes: new Uint8Array() },
  ]
}

describe('import Notion', () => {
  it('retire les identifiants, garde page + dossier, numerote les homonymes', () => {
    const { files, report } = convertNotionExport(exportFiles())
    const paths = files.map(x => x.path).sort()
    expect(paths).toEqual([
      'Accueil.md',
      'Accueil/Note (2).md',
      'Accueil/Note.md',
      'Accueil/Projets.base',
      'Accueil/Projets/Archivé.md',
      'Accueil/Projets/Logo.md',
      'Accueil/Projets/Sans page.md',
      'Accueil/Projets/Site web.md',
      'Accueil/logo.png',
    ].sort())
    expect(report).toMatchObject({ pages: 3, databases: 1, rows: 4, files: 1, unresolvedLinks: 1 })
  })

  it('reecrit les liens internes, garde les externes et les liens absents', () => {
    const { files } = convertNotionExport(exportFiles())
    const text = (p: string) => dec.decode(files.find(x => x.path === p)!.bytes)
    const home = text('Accueil.md')
    expect(home).toContain('[[Accueil/Projets.base|Projets]]')
    expect(home).toContain('[[Accueil/Note|Note]]')
    expect(home).toContain('[le site](https://example.org)')
    expect(home).toContain('![[Accueil/logo.png]]')
    expect(home).toContain(`[Disparue](Autre%20${ID5}.md)`)
    expect(text('Accueil/Note.md')).toContain('[[Accueil]]')
  })

  it('les valeurs des lignes passent en frontmatter, typees ; les lignes de proprietes disparaissent', () => {
    const { files } = convertNotionExport(exportFiles())
    const text = (p: string) => dec.decode(files.find(x => x.path === p)!.bytes)
    expect(text('Accueil/Projets/Logo.md')).toBe('---\nStatut: En cours\nPrix: 300\nFait: false\nÉchéance: 2026-10-05\nTags: [design, print]\n---\n# Logo\n\nLe logo du projet.\n')
    expect(text('Accueil/Projets/Site web.md')).toBe('---\nStatut: Fini\nPrix: 1200\nFait: true\nÉchéance: 2026-11-08\nTags: [web]\n---\n# Site web\n\nContenu.\n')
    // Ligne sans page : une note avec ses valeurs.
    expect(text('Accueil/Projets/Sans page.md')).toBe('---\nStatut: À faire\nFait: false\n---\n# Sans page\n')
    expect(text('Accueil/Projets.base')).toBe('')
  })

  it('CSV, types de colonnes et identifiants', () => {
    expect(parseCsv('a,"b,c","d ""e"""\r\n1,"x\ny",3\n')).toEqual([['a', 'b,c', 'd "e"'], ['1', 'x\ny', '3']])
    expect(columnKind(['1', '2.5', ''])).toBe('number')
    expect(columnKind(['Yes', 'No'])).toBe('checkbox')
    expect(columnKind(['Une phrase, avec virgule. Et une autre.'])).toBe('text')
    expect(stripId(`Ma page ${ID1}`)).toBe('Ma page')
    expect(stripId(ID1)).toBe(ID1)
  })

  it('lit une archive zip, compressee ou non, et ouvre les archives imbriquees', async () => {
    const inner = zip([{ path: 'Page.md', data: enc.encode('# Page'), deflate: true }])
    const outer = zip([
      { path: 'Partie-1.zip', data: inner, deflate: false },
      { path: 'dossier/é.txt', data: enc.encode('accent'), deflate: true },
    ])
    const files = await readZip(outer)
    expect(files.map(x => [x.path, dec.decode(x.bytes)])).toEqual([['Page.md', '# Page'], ['dossier/é.txt', 'accent']])
  })
})

/** Archive minimale pour le test (crc non verifie a la lecture). */
function zip(entries: { path: string; data: Uint8Array; deflate: boolean }[]): Uint8Array {
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const e of entries) {
    const name = enc.encode(e.path)
    const body = e.deflate ? new Uint8Array(deflateRawSync(e.data)) : e.data
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, e.deflate ? 8 : 0, true)
    lv.setUint32(18, body.length, true); lv.setUint32(22, e.data.length, true); lv.setUint16(26, name.length, true)
    local.set(name, 30)
    const c = new Uint8Array(46 + name.length)
    const cv = new DataView(c.buffer)
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, e.deflate ? 8 : 0, true)
    cv.setUint32(20, body.length, true); cv.setUint32(24, e.data.length, true); cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    c.set(name, 46)
    chunks.push(local, body); central.push(c)
    offset += local.length + body.length
  }
  const size = central.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true)
  ev.setUint32(12, size, true); ev.setUint32(16, offset, true)
  const all = [...chunks, ...central, end]
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0))
  let p = 0
  for (const c of all) { out.set(c, p); p += c.length }
  return out
}
