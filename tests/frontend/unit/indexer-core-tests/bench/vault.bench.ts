// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Banc d'essai reproductible du noyau d'indexation (node:sqlite, fichier sur
// disque, WAL). Hors des tests rapides :
//   pnpm bench   (ou npx vitest run --config vitest.bench.config.ts)
// Reglages : BENCH_NOTES (10 000), BENCH_ROWS (100 000 lignes legeres),
// BENCH_KEEP=1 pour garder les fichiers SQLite.
//
// Vault genere (graine fixe) : dossiers, frontmatter type (statut, priorite,
// echeance, tags, case), 1 a 3 Ko de texte, titres, [[liens]] (dont des
// cibles absentes), #tags. Mesures : construction complete, mise a jour
// d'une note, requete filtree triee (et page suivante), groupBy, recherche
// plein texte, retroliens, tags, taille du fichier ; puis une base de
// 100 000 lignes legeres.
import { it } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultIndex, extractNote, makeRecord } from '@savoire/indexer-core'
import type { NoteInput, NoteRecord } from '@savoire/indexer-core'
import { NodeSqliteDriver } from '@savoire/indexer-core/node'
import type { Query } from '@savoire/plugin-api'

const NOTES = Number(process.env.BENCH_NOTES ?? 10_000)
const ROWS = Number(process.env.BENCH_ROWS ?? 100_000)

/** Generateur pseudo-aleatoire a graine (mulberry32) : meme vault a chaque fois. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = ('le la les un une des du de et ou mais donc car ni que qui quoi dont où réseau électrique ville projet '
  + 'réunion client budget équipe planning livraison rapport analyse données serveur index recherche note dossier '
  + 'archive tâche priorité échéance réseau électricité centrale énergie solaire éolien batterie stockage compteur '
  + 'facture contrat partenaire fournisseur commande produit qualité test version déploiement sécurité accès '
  + 'utilisateur compte mot passe document page carte schéma idée question réponse décision action suivi bilan '
  + 'semaine mois année matin soir lundi mardi mercredi jeudi vendredi Paris Lyon Marseille Nantes Lille Bordeaux '
  + 'important urgent simple rapide lent nouveau ancien grand petit premier dernier prochain possible nécessaire').split(' ')
const STATUS = ['À faire', 'En cours', 'En attente', 'Terminé', 'Abandonné']
const TAGS = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? `projet/p${i}` : `tag${i}`))
const FOLDERS = Array.from({ length: 20 }, (_, i) => (i % 4 === 0 ? `Dossier ${i}/Sous ${i % 3}` : `Dossier ${i}`))

/** Vocabulaire : les mots courants, puis 20 000 mots inventes ; tirage selon une loi de Zipf. */
function vocabulary(r: () => number): string[] {
  const syl = ['ba', 'lo', 'ti', 'ra', 'mé', 'su', 'ver', 'con', 'dé', 'ple', 'cha', 'gni', 'tou', 'pré', 'sio', 'nel', 'ar', 'bri', 'qua', 'lé']
  const out = [...WORDS]
  const seen = new Set(out)
  while (out.length < WORDS.length + 20_000) {
    const w = Array.from({ length: 2 + Math.floor(r() * 3) }, () => syl[Math.floor(r() * syl.length)]).join('')
    if (!seen.has(w)) { seen.add(w); out.push(w) }
  }
  return out
}

function generate(n: number): NoteInput[] {
  const r = rng(42)
  const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)]
  const vocab = vocabulary(r)
  const zipf = () => vocab[Math.min(vocab.length - 1, Math.floor(Math.exp(r() * Math.log(vocab.length + 1))) - 1)]
  const sentence = () => {
    const len = 6 + Math.floor(r() * 14)
    const w = Array.from({ length: len }, () => zipf())
    w[0] = w[0][0].toUpperCase() + w[0].slice(1)
    return w.join(' ') + '.'
  }
  const names = Array.from({ length: n }, (_, i) => `Note ${i} ${pick(WORDS)}`)
  return names.map((name, i) => {
    const folder = pick(FOLDERS)
    const tags = [...new Set(Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(TAGS)))]
    const fm = [
      '---',
      `statut: ${pick(STATUS)}`,
      `priorite: ${1 + Math.floor(r() * 5)}`,
      `echeance: 2026-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`,
      `tags: [${tags.join(', ')}]`,
      `fait: ${r() < 0.3}`,
      `client: ${pick(['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli'])}`,
      '---',
    ]
    const target = 1000 + Math.floor(r() * 2000)
    const body: string[] = [`# ${name}`, '']
    let size = 0
    let section = 0
    while (size < target) {
      if (size > section * 700) {
        section++
        body.push(`## Partie ${section} ${pick(WORDS)}`, '')
      }
      const parts = [sentence(), sentence(), sentence()]
      if (r() < 0.5) parts.push(`Voir [[${r() < 0.95 ? names[Math.floor(r() * n)] : 'Absente ' + Math.floor(r() * 50)}]].`)
      if (r() < 0.3) parts.push(`#${pick(TAGS)}`)
      const p = parts.join(' ')
      body.push(p, '')
      size += p.length
    }
    return { id: `id-${String(i).padStart(6, '0')}`, path: `${folder}/${name}.md`, content: [...fm, ...body].join('\n') }
  })
}

async function time<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now()
  const v = await fn()
  return [v, performance.now() - t0]
}

async function avg(times: number, fn: (i: number) => Promise<unknown>): Promise<number> {
  await fn(0)
  const t0 = performance.now()
  for (let i = 0; i < times; i++) await fn(i)
  return (performance.now() - t0) / times
}

const ms = (x: number) => `${x.toFixed(x < 10 ? 2 : 0)} ms`

it(`banc : vault de ${NOTES} notes, base de ${ROWS} lignes`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'savoire-bench-'))
  const lines: string[] = []
  const log = (k: string, v: string) => { lines.push(`| ${k} | ${v} |`); console.log(`${k.padEnd(52)} ${v}`) }
  try {
    const notes = generate(NOTES)
    const bytes = notes.reduce((s, n) => s + n.content.length, 0)
    log('Notes generees (texte total)', `${NOTES} (${(bytes / 1e6).toFixed(1)} Mo)`)

    const [, tExtract] = await time(async () => { for (const n of notes) extractNote(n) })
    log('Extraction seule (par note)', ms(tExtract / NOTES))

    const file = join(dir, 'vault.sqlite')
    const driver = NodeSqliteDriver.open(file)
    const index = await VaultIndex.open(driver)
    const [, tBuild] = await time(async () => {
      for (let i = 0; i < notes.length; i += 200) await index.applyDocs(notes.slice(i, i + 200), { seq: i })
      await index.markBuilt()
    })
    log('Construction complete (lots de 200)', `${(tBuild / 1000).toFixed(1)} s (${Math.round(NOTES / (tBuild / 1000))} notes/s)`)

    const tUpdate = await avg(50, async i => {
      const n = notes[(i * 197) % NOTES]
      await index.applyDoc({ ...n, content: n.content + `\nAjout ${i} #nouveau [[${notes[i].path.replace(/^.*\//, '').replace(/\.md$/, '')}]]` })
    })
    log('Mise a jour d une note (une transaction)', ms(tUpdate))

    const q: Query = {
      from: { notes: true },
      where: { and: [{ field: { prop: 'statut' }, op: 'eq', value: 'en cours' }, { field: { prop: 'priorite' }, op: 'gte', value: 3 }] },
      sort: [{ field: { prop: 'echeance' }, dir: 'desc' }],
      limit: 50,
    }
    const qe = index.queryEngine()
    const first = await qe.query(q)
    log('Requete filtree triee (resultats)', String(first.total))
    log('  premiere page de 50', ms(await avg(20, () => qe.query(q))))
    log('  page suivante (curseur)', ms(await avg(20, () => qe.query({ ...q, cursor: first.next }))))
    log('Tri seul sur toutes les notes (echeance)', ms(await avg(10, () => qe.query({ from: { notes: true }, sort: [{ field: { prop: 'echeance' } }] }))))
    log('groupBy statut (toutes les notes)', ms(await avg(10, () => qe.query({ from: { notes: true }, groupBy: { prop: 'statut' }, limit: 1 }))))
    log('groupBy tags (liste)', ms(await avg(10, () => qe.query({ from: { notes: true }, groupBy: { prop: 'tags' }, limit: 1 }))))
    log('Query.text (mots du titre et du texte)', ms(await avg(10, () => qe.query({ from: { notes: true }, text: 'reseau electri', limit: 50 }))))

    const se = index.searchEngine()
    const searches = ['le', 'réseau électrique', 'budget', 'livraison serveur', '"rapport analyse"', 'facture contrat partenaire', 'bordeaux', 'balo']
    for (const text of searches) {
      const r = await se.search({ text })
      log(`Recherche « ${text} » (${r.total} notes)`, ms(await avg(10, () => se.search({ text }))))
    }

    const hub = notes[1]
    log('Retroliens d une note', ms(await avg(20, () => index.call('links', 'backlinks', { id: hub.id }))))
    log('Liens non resolus (200 premiers)', ms(await avg(5, () => index.call('links', 'unresolved', {}))))
    log('Graphe (2 000 notes les plus reliees)', ms(await avg(3, () => index.call('links', 'graph', {}))))
    log('Liste des tags', ms(await avg(10, () => index.call('tags', 'list', {}))))

    await driver.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    log('Taille du fichier SQLite', `${(statSync(file).size / 1e6).toFixed(1)} Mo`)
    await index.close()

    // ── Base de lignes legeres ────────────────────────────────────────────
    const r = rng(7)
    const rows: NoteRecord[] = Array.from({ length: ROWS }, (_, i) => makeRecord({
      id: `row-${i}`, path: '', base: 'B', title: `Ligne ${i}`,
      props: {
        statut: STATUS[Math.floor(r() * STATUS.length)],
        montant: Math.round(r() * 100_000) / 100,
        date: `2026-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`,
        tags: [TAGS[Math.floor(r() * TAGS.length)]],
      },
    }))
    const file2 = join(dir, 'base.sqlite')
    const driver2 = NodeSqliteDriver.open(file2)
    const index2 = await VaultIndex.open(driver2)
    const [, tRows] = await time(async () => { for (let i = 0; i < rows.length; i += 1000) await index2.applyRecords(rows.slice(i, i + 1000)) })
    log(`Base de ${ROWS} lignes : chargement`, `${(tRows / 1000).toFixed(1)} s`)
    const qe2 = index2.queryEngine()
    const bq: Query = {
      from: { base: 'B' },
      where: { and: [{ field: { prop: 'statut' }, op: 'eq', value: 'en cours' }, { field: { prop: 'montant' }, op: 'gt', value: 500 }] },
      sort: [{ field: { prop: 'date' }, dir: 'desc' }, { field: { prop: 'montant' } }],
      limit: 50,
    }
    const b1 = await qe2.query(bq)
    log(`  filtre + tri (${b1.total} lignes)`, ms(await avg(10, () => qe2.query(bq))))
    log('  page suivante', ms(await avg(10, () => qe2.query({ ...bq, cursor: b1.next }))))
    log('  tri seul sur toutes les lignes', ms(await avg(5, () => qe2.query({ from: { base: 'B' }, sort: [{ field: { prop: 'montant' }, dir: 'desc' }] }))))
    log('  groupBy statut', ms(await avg(5, () => qe2.query({ from: { base: 'B' }, groupBy: { prop: 'statut' }, limit: 1 }))))
    log('  modification d une ligne', ms(await avg(50, i => index2.applyRecords([{ ...rows[i * 13], props: { ...rows[i * 13].props, statut: 'Terminé' } }]))))
    await driver2.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    log('  taille du fichier', `${(statSync(file2).size / 1e6).toFixed(1)} Mo`)
    await index2.close()
    console.log('\n' + lines.join('\n'))
  } finally {
    // BENCH_KEEP=1 : garder les fichiers pour les examiner.
    if (process.env.BENCH_KEEP) console.log(`Fichiers gardes dans ${dir}`)
    else rmSync(dir, { recursive: true, force: true })
  }
})
