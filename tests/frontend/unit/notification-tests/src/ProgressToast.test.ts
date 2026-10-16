// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Notifications « en cours » (envoi d'un fichier) et pont des envois.
import { describe, it, expect, beforeEach } from 'vitest'
import { notifyProgress, dismiss, subscribeToasts } from '@savoire/notifications'
import type { Toast } from '@savoire/notifications'
import { UploadTracker } from '@savoire/platform'
import { showUploadsAsToasts } from '../../../../../apps/web/src/uploadToasts'

function current(): Toast[] {
  let list: Toast[] = []
  subscribeToasts(t => { list = t })()
  return list
}

beforeEach(() => {
  for (const t of current()) dismiss(t.id)
})

describe('notifyProgress()', () => {
  it('cree une notification en cours, sans progression connue', () => {
    notifyProgress('Envoi', 'a.png')
    expect(current()).toEqual([expect.objectContaining({ type: 'info', title: 'Envoi', message: 'a.png', pending: true, progress: null })])
  })

  it('avance (bornee a 0..1) puis se termine en succes sur place', () => {
    const p = notifyProgress('Envoi', 'a.png')
    p.update(0.4)
    expect(current()[0].progress).toBe(0.4)
    p.update(7)
    expect(current()[0].progress).toBe(1)
    p.succeed('Image envoyée', 'a.png')
    const [t] = current()
    expect(t).toMatchObject({ id: p.id, type: 'success', title: 'Image envoyée', pending: false })
    p.update(0.1)
    p.fail('trop tard')
    expect(current()).toHaveLength(1)
    expect(current()[0].type).toBe('success')
  })

  it('un echec reste visible meme si la personne avait ferme la notification', () => {
    const p = notifyProgress('Envoi', 'a.png')
    dismiss(p.id)
    p.fail('Échec', 'a.png : erreur du serveur')
    expect(current()).toEqual([expect.objectContaining({ type: 'danger', title: 'Échec', message: 'a.png : erreur du serveur' })])
  })

  it('un succes apres fermeture ne reapparait pas', () => {
    const p = notifyProgress('Envoi', 'a.png')
    dismiss(p.id)
    p.succeed('ok')
    expect(current()).toHaveLength(0)
  })
})

describe('showUploadsAsToasts()', () => {
  it('une ligne par fichier : progression, puis succes ou erreur avec le nom et la raison', () => {
    const tracker = new UploadTracker()
    const stop = showUploadsAsToasts(cb => tracker.subscribe(cb))
    const a = tracker.begin('a.png')
    const b = tracker.begin('b.png')
    expect(current().map(t => [t.message, t.pending])).toEqual([['a.png', true], ['b.png', true]])
    a.progress(0.5)
    expect(current()[0].progress).toBe(0.5)
    a.done('Note/a.png')
    b.fail(new Error('400'))
    const [ta, tb] = current()
    expect(ta).toMatchObject({ type: 'success', message: 'a.png → rangée dans Note/' })
    expect(tb).toMatchObject({ type: 'danger', title: 'Échec de l\'envoi' })
    expect(tb.message).toMatch(/^b\.png : fichier refusé/)
    stop()
  })
})
