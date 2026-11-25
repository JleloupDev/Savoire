// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les modifications de l'IA, chacune annulable seule (AiChanges.ts) : un
// point par ecriture, range dans la note, qui garde les operations (pas de
// copie de la note), compacte apres quelques minutes.
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  AI_CHANGE_BUCKET_MS, AI_CHANGE_SETTLE_MS, AiChangeTracker, aiChangeRanges, compactAiChanges, displayAiChanges, listAiChanges,
  recordAiChange, undoAiChanges, type AiChangeMeta,
} from '../../../../../packages/infrastructure-sync/src/AiChanges'
import { YjsCrdtAdapter } from '../../../../../packages/infrastructure-sync/src/YjsCrdtAdapter'

const META: AiChangeMeta = { agent: { id: 'a1', name: 'Archiviste', color: '#7c3aed' }, forUser: { id: 'u1', name: 'Jean' }, summary: 'passage remplacé', reason: 'plus clair' }
const JEAN = { id: 'u1', name: 'Jean' }
const T0 = Date.parse('2026-11-25T10:00:00Z')

function note(content: string): { doc: Y.Doc; text: Y.Text } {
  const doc = new Y.Doc()
  const text = doc.getText('codemirror')
  text.insert(0, content)
  return { doc, text }
}

/** Ce que fait l'agent : `fn` dans capture, puis le point. */
function agentWrites(doc: Y.Doc, text: Y.Text, fn: (t: Y.Text) => void, meta = META, now = T0): string {
  const tracker = new AiChangeTracker(text)
  tracker.capture(() => doc.transact(() => fn(text)))
  return recordAiChange(doc, tracker.ops, meta, now)!
}

function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}

describe('AiChanges : un point par ecriture de l’IA', () => {
  it('annule un ajout, et seulement lui', () => {
    const { doc, text } = note('Bonjour. Fin.')
    const id = agentWrites(doc, text, t => t.insert(9, 'Texte de l’IA. '))
    expect(text.toString()).toBe('Bonjour. Texte de l’IA. Fin.')
    // La personne tape ensuite au milieu du texte de l'IA, et avant.
    text.insert(14, 'XX')
    text.insert(0, '> ')
    const r = undoAiChanges(doc, text, [id], JEAN, T0 + 1000)
    expect(r).toEqual({ ok: true, partial: false })
    expect(text.toString()).toBe('> Bonjour. XXFin.')
    expect(listAiChanges(doc)[0]!.change.undone?.by).toEqual(JEAN)
    // Deux fois : rien de plus.
    expect(undoAiChanges(doc, text, [id], JEAN).ok).toBe(false)
  })

  it('un remplacement : annuler remet le texte d’avant, meme si la note a bouge autour', () => {
    const { doc, text } = note('Un. Deux mots ici. Trois.')
    const id = agentWrites(doc, text, t => { t.delete(4, 14); t.insert(4, 'Autre chose.') })
    expect(text.toString()).toBe('Un. Autre chose. Trois.')
    text.insert(0, 'Titre\n')
    text.insert(text.toString().length, ' Quatre.')
    undoAiChanges(doc, text, [id], JEAN)
    expect(text.toString()).toBe('Titre\nUn. Deux mots ici. Trois. Quatre.')
  })

  it('une suppression seule revient a sa place', () => {
    const { doc, text } = note('Garder. Retirer ceci. Garder aussi.')
    const id = agentWrites(doc, text, t => t.delete(8, 14))
    expect(text.toString()).toBe('Garder. Garder aussi.')
    undoAiChanges(doc, text, [id], JEAN)
    expect(text.toString()).toBe('Garder. Retirer ceci. Garder aussi.')
  })

  it('effet de frappe : les morceaux font une seule insertion ; ce que tape la personne entre deux n’en est pas', () => {
    const { doc, text } = note('Début. ')
    const tracker = new AiChangeTracker(text)
    tracker.capture(() => text.insert(7, 'Un '))
    text.insert(0, '#') // la personne, hors capture
    tracker.capture(() => text.insert(11, 'deux '))
    tracker.capture(() => text.insert(16, 'trois.'))
    // Les morceaux qui se suivent font une seule insertion (la frappe de la
    // personne, sur le meme client, coupe la suite des identifiants).
    expect(tracker.ops.map(o => [o.kind, o.text])).toEqual([['insert', 'Un '], ['insert', 'deux trois.']])
    const id = recordAiChange(doc, tracker.ops, META, T0)!
    undoAiChanges(doc, text, [id], JEAN)
    expect(text.toString()).toBe('#Début. ')
  })

  it('le point voyage avec la note : ecrit chez l’un, annule chez l’autre', () => {
    const a = note('Texte commun.')
    const b = { doc: new Y.Doc() }
    sync(a.doc, b.doc)
    const id = agentWrites(a.doc, a.text, t => t.insert(13, ' Ajout.'))
    sync(a.doc, b.doc)
    const textB = b.doc.getText('codemirror')
    expect(textB.toString()).toBe('Texte commun. Ajout.')
    undoAiChanges(b.doc, textB, [id], JEAN)
    sync(a.doc, b.doc)
    expect(a.text.toString()).toBe('Texte commun.')
    expect(listAiChanges(a.doc)[0]!.change.undone).toBeDefined()
  })

  it('les traces d’un point : le texte ajoute encore la, l’endroit d’une suppression', () => {
    const { doc, text } = note('aaa bbb ccc')
    const id = agentWrites(doc, text, t => { t.delete(4, 3); t.insert(4, 'XYZ') })
    text.insert(5, '-')
    const r = aiChangeRanges(doc, text, [id])
    expect(r.inserted).toEqual([{ from: 4, to: 5 }, { from: 6, to: 8 }])
    expect(r.deleted).toEqual([{ at: 4, text: 'bbb' }])
  })

  it('rien ne change : pas de point', () => {
    const { doc, text } = note('x')
    const tracker = new AiChangeTracker(text)
    tracker.capture(() => undefined)
    expect(recordAiChange(doc, tracker.ops, META, T0)).toBeNull()
  })
})

describe('AiChanges : compactage', () => {
  it('apres la tranche, les points d’un meme agent se fondent ; qui et pourquoi restent', () => {
    const { doc, text } = note('Note.')
    const start = Math.floor(T0 / AI_CHANGE_BUCKET_MS) * AI_CHANGE_BUCKET_MS
    agentWrites(doc, text, t => t.insert(5, ' Un.'), { ...META, summary: 'texte ajouté', reason: 'r1' }, start + 1000)
    agentWrites(doc, text, t => t.insert(9, ' Deux.'), { ...META, summary: 'texte ajouté', reason: 'r2' }, start + 2000)
    agentWrites(doc, text, t => t.insert(0, '# '), { ...META, agent: { id: 'a2', name: 'Autre' }, summary: 'titre' }, start + 3000)
    // Tranche encore ouverte : trois points.
    expect(displayAiChanges(doc, start + 4000)).toHaveLength(3)
    const later = start + AI_CHANGE_BUCKET_MS + AI_CHANGE_SETTLE_MS
    // A l'affichage, deja fondus ; dans la carte, pas encore.
    const shown = displayAiChanges(doc, later)
    expect(shown).toHaveLength(2)
    const merged = shown.find(c => c.agent.id === 'a1')!
    expect(merged).toMatchObject({ count: 2, reasons: ['r1', 'r2'], summaries: ['texte ajouté', 'texte ajouté'], forUser: JEAN })
    expect(merged.parts).toHaveLength(2)
    expect(listAiChanges(doc)).toHaveLength(3)
    // Range : meme resultat, une cle stable.
    compactAiChanges(doc, later)
    expect(listAiChanges(doc)).toHaveLength(2)
    expect(displayAiChanges(doc, later).find(c => c.agent.id === 'a1')).toMatchObject({ count: 2, reasons: ['r1', 'r2'] })
    // Annuler le point compacte annule les deux ecritures.
    const after = displayAiChanges(doc, later).find(c => c.agent.id === 'a1')!
    undoAiChanges(doc, text, after.parts, JEAN, later)
    expect(text.toString()).toBe('# Note.')
  })

  it('deux hotes qui compactent en meme temps tombent d’accord', () => {
    const a = note('N.')
    const start = Math.floor(T0 / AI_CHANGE_BUCKET_MS) * AI_CHANGE_BUCKET_MS
    agentWrites(a.doc, a.text, t => t.insert(2, ' 1'), META, start + 10)
    agentWrites(a.doc, a.text, t => t.insert(4, ' 2'), META, start + 20)
    const b = new Y.Doc()
    sync(a.doc, b)
    const later = start + AI_CHANGE_BUCKET_MS + AI_CHANGE_SETTLE_MS
    compactAiChanges(a.doc, later)
    compactAiChanges(b, later)
    sync(a.doc, b)
    expect(listAiChanges(a.doc)).toHaveLength(1)
    expect(listAiChanges(b)).toEqual(listAiChanges(a.doc))
  })
})

describe('YjsCrdtAdapter : les modifications de l’IA', () => {
  it('beginAiChange, aiChanges, aiChangeRanges, undoAiChange, et le signal des nouveaux points', () => {
    const crdt = new YjsCrdtAdapter()
    const shared = crdt.sharedText()
    shared.applyDelta([{ insert: 'Bonjour.' }])
    const seen: string[][] = []
    const off = crdt.onAiChangesChange(added => seen.push(added))
    const rec = crdt.beginAiChange(META)
    rec.capture(() => shared.applyDelta([{ retain: 8 }, { insert: ' Suite.' }]))
    const id = rec.commit()!
    expect(rec.commit()).toBeNull()
    expect(seen.flat()).toContain(id)
    const [info] = crdt.aiChanges()
    expect(info).toMatchObject({ id, parts: [id], agent: { name: 'Archiviste' }, inserted: 7, deleted: 0, reasons: ['plus clair'] })
    expect(crdt.aiChangeRanges([id]).inserted).toEqual([{ from: 8, to: 15 }])
    expect(crdt.undoAiChange([id], JEAN)).toEqual({ ok: true, partial: false })
    expect(shared.toString()).toBe('Bonjour.')
    expect(crdt.aiChanges()[0]!.undone?.by).toEqual(JEAN)
    off()
    crdt.dispose()
  })
})
