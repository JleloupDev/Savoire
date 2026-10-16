// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import { UploadTracker, uploadErrorReason, type UploadEvent } from '@savoire/platform'

describe('UploadTracker', () => {
  it('annonce le debut, la progression (bornee) puis la fin, une seule fois', () => {
    const tracker = new UploadTracker()
    const events: UploadEvent[] = []
    tracker.subscribe(e => events.push(e))
    const report = tracker.begin('a.png')
    report.progress(0.5)
    report.progress(2)
    report.done('Note/a.png')
    report.fail(new Error('trop tard'))
    report.progress(0.1)
    expect(events).toEqual([
      { kind: 'progress', uploadId: 1, fileName: 'a.png', fraction: null },
      { kind: 'progress', uploadId: 1, fileName: 'a.png', fraction: 0.5 },
      { kind: 'progress', uploadId: 1, fileName: 'a.png', fraction: 1 },
      { kind: 'done', uploadId: 1, fileName: 'a.png', path: 'Note/a.png' },
    ])
  })

  it('un abonne qui plante ne bloque pas les autres', () => {
    const tracker = new UploadTracker()
    const seen: string[] = []
    tracker.subscribe(() => { throw new Error('boum') })
    tracker.subscribe(e => seen.push(e.kind))
    const original = console.error
    console.error = () => {}
    tracker.begin('a.png').fail(new Error('500'))
    console.error = original
    expect(seen).toEqual(['progress', 'error'])
  })

  it('traduit les erreurs en raisons lisibles', () => {
    expect(uploadErrorReason(new Error('400'))).toMatch(/refusé/)
    expect(uploadErrorReason(new Error('403'))).toMatch(/droit/)
    expect(uploadErrorReason(new TypeError('Failed to fetch'))).toBe('connexion perdue')
    expect(uploadErrorReason(new Error('autre chose'))).toBe('autre chose')
  })
})
