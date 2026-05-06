// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { IndexEngine } from './IndexEngine'
import { HashtagContributor } from './contributors/HashtagContributor'
import { WikilinkContributor } from './contributors/WikilinkContributor'
import { HeadingContributor, type HeadingMeta } from './contributors/HeadingContributor'
import { FilenameContributor } from './contributors/FilenameContributor'

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDoc(text: string): { doc: Y.Doc; ytext: Y.Text } {
  const doc = new Y.Doc()
  doc.gc = false
  const ytext = doc.getText('content')
  ytext.insert(0, text)
  return { doc, ytext }
}

function engine(...contributors: ConstructorParameters<typeof IndexEngine>[0] extends never ? never[] : Parameters<IndexEngine['register']>[0][]) {
  const e = new IndexEngine()
  for (const c of contributors) e.register(c)
  return e
}

// ── W — WikilinkContributor ────────────────────────────────────────────────────

describe('W1 — basic wikilink detection', () => {
  it('indexes the target of [[target]]', () => {
    const { doc, ytext } = makeDoc('see [[Introduction]] for details')
    const e = new IndexEngine()
    e.register(new WikilinkContributor())
    e.onYjsChange(ytext, doc, 'doc1')

    expect(e.index.getByValue('wikilinks', 'Introduction')).toHaveLength(1)
  })
})

describe('W2 — wikilink with alias', () => {
  it('indexes the target, not the alias', () => {
    const { doc, ytext } = makeDoc('see [[Introduction|Intro]] for details')
    const e = new IndexEngine()
    e.register(new WikilinkContributor())
    e.onYjsChange(ytext, doc, 'doc1')

    expect(e.index.getByValue('wikilinks', 'Introduction')).toHaveLength(1)
    expect(e.index.getByValue('wikilinks', 'Intro')).toHaveLength(0)
    expect(e.index.getByValue('wikilinks', 'Introduction|Intro')).toHaveLength(0)
  })
})

describe('W3 — multiple wikilinks, same target twice', () => {
  it('creates two separate entries for the same target at different positions', () => {
    const { doc, ytext } = makeDoc('[[Notes]] and also [[Notes]]')
    const e = new IndexEngine()
    e.register(new WikilinkContributor())
    e.onYjsChange(ytext, doc, 'doc1')

    // Same value, different anchor pairs → different IDs
    const entries = e.index.getByValue('wikilinks', 'Notes')
    expect(entries).toHaveLength(2)
    expect(entries[0]!.id).not.toBe(entries[1]!.id)
  })
})

describe('W4 — anchors survive insertion before [[', () => {
  it('wikilink stays valid after text inserted before it', () => {
    const { doc, ytext } = makeDoc('see [[Notes]] here')
    const e = new IndexEngine()
    e.register(new WikilinkContributor())
    e.onYjsChange(ytext, doc, 'doc1')

    ytext.insert(0, 'Please ')
    e.onYjsChange(ytext, doc, 'doc1')

    expect(ytext.toString()).toBe('Please see [[Notes]] here')
    expect(e.index.getByValue('wikilinks', 'Notes')).toHaveLength(1)
  })
})

describe('W5 — wikilink target renamed', () => {
  it('removes old entry and adds new one when target text changes', () => {
    const { doc, ytext } = makeDoc('[[OldName]]')
    const e = new IndexEngine()
    e.register(new WikilinkContributor())
    e.onYjsChange(ytext, doc, 'doc1')
    expect(e.index.getByValue('wikilinks', 'OldName')).toHaveLength(1)

    // Simulate user editing "OldName" → "NewName"
    ytext.delete(2, 7)  // delete "OldName"
    ytext.insert(2, 'NewName')
    e.onYjsChange(ytext, doc, 'doc1')

    expect(e.index.getByValue('wikilinks', 'OldName')).toHaveLength(0)
    expect(e.index.getByValue('wikilinks', 'NewName')).toHaveLength(1)
  })
})

// ── H — HeadingContributor ────────────────────────────────────────────────────

describe('H1 — basic heading detection', () => {
  it('indexes H1 with level=1 in meta', () => {
    const { doc, ytext } = makeDoc('# Introduction\n\nSome text.')
    const e = new IndexEngine()
    e.register(new HeadingContributor())
    e.onYjsChange(ytext, doc, 'doc1')

    const entries = e.index.getByValue('headings', 'Introduction')
    expect(entries).toHaveLength(1)
    expect((entries[0]!.meta as HeadingMeta).level).toBe(1)
  })
})

describe('H2 — multiple heading levels', () => {
  it('captures level correctly for each heading', () => {
    const { doc, ytext } = makeDoc('# Title\n## Section\n### Sub')
    const e = new IndexEngine()
    e.register(new HeadingContributor())
    e.onYjsChange(ytext, doc, 'doc1')

    expect((e.index.getByValue('headings', 'Title')[0]!.meta as HeadingMeta).level).toBe(1)
    expect((e.index.getByValue('headings', 'Section')[0]!.meta as HeadingMeta).level).toBe(2)
    expect((e.index.getByValue('headings', 'Sub')[0]!.meta as HeadingMeta).level).toBe(3)
  })
})

describe('H3 — two headings with the same text', () => {
  it('creates two separate entries with different IDs', () => {
    const { doc, ytext } = makeDoc('# Notes\n\nSome text.\n\n# Notes')
    const e = new IndexEngine()
    e.register(new HeadingContributor())
    e.onYjsChange(ytext, doc, 'doc1')

    const entries = e.index.getByValue('headings', 'Notes')
    expect(entries).toHaveLength(2)
    expect(entries[0]!.id).not.toBe(entries[1]!.id)
  })
})

describe('H4 — heading text edited', () => {
  it('detects invalidation and re-indexes with new text', () => {
    const { doc, ytext } = makeDoc('# Introduction')
    const e = new IndexEngine()
    e.register(new HeadingContributor())
    e.onYjsChange(ytext, doc, 'doc1')
    expect(e.index.getByValue('headings', 'Introduction')).toHaveLength(1)

    ytext.insert(2, 'Brief ')  // "# Brief Introduction"
    e.onYjsChange(ytext, doc, 'doc1')

    expect(e.index.getByValue('headings', 'Introduction')).toHaveLength(0)
    expect(e.index.getByValue('headings', 'Brief Introduction')).toHaveLength(1)
  })
})

// ── F — FilenameContributor ───────────────────────────────────────────────────

describe('F1 — filename extracted from path', () => {
  it('indexes the stem (without extension)', () => {
    const e = new IndexEngine()
    e.registerMetadata(new FilenameContributor())
    e.onPathChange('doc1', 'Inbox/My Note.md')

    const entries = e.index.getByValue('filename', 'My Note')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.docId).toBe('doc1')
  })
})

describe('F2 — singleton: rename overwrites previous entry', () => {
  it('second onPathChange replaces the first — one entry per doc', () => {
    const e = new IndexEngine()
    e.registerMetadata(new FilenameContributor())
    e.onPathChange('doc1', 'Inbox/Old Name.md')
    e.onPathChange('doc1', 'Inbox/New Name.md')

    expect(e.index.query('filename')).toHaveLength(1)
    expect(e.index.getByValue('filename', 'New Name')).toHaveLength(1)
    expect(e.index.getByValue('filename', 'Old Name')).toHaveLength(0)
  })
})

describe('F3 — filename entry has no anchors', () => {
  it('entry has no anchor1/anchor2 (not in Y.Text)', () => {
    const e = new IndexEngine()
    e.registerMetadata(new FilenameContributor())
    e.onPathChange('doc1', 'note.md')

    const entry = e.index.query('filename')[0]!
    expect(entry.anchor1).toBeUndefined()
    expect(entry.anchor2).toBeUndefined()
  })
})

describe('F4 — multiple documents', () => {
  it('each doc has its own filename entry', () => {
    const e = new IndexEngine()
    e.registerMetadata(new FilenameContributor())
    e.onPathChange('doc1', 'Inbox/Alpha.md')
    e.onPathChange('doc2', 'Archive/Beta.md')

    expect(e.index.query('filename')).toHaveLength(2)
    expect(e.index.getByValue('filename', 'Alpha')[0]!.docId).toBe('doc1')
    expect(e.index.getByValue('filename', 'Beta')[0]!.docId).toBe('doc2')
  })
})

// ── E — IndexEngine multi-contributors ───────────────────────────────────────

describe('E1 — multiple contributors process the same change independently', () => {
  it('hashtag and wikilink contributors both index from the same document', () => {
    const { doc, ytext } = makeDoc('# My Note\n\nSee [[Ref]] and tag #todo')
    const e = new IndexEngine()
    e.register(new HashtagContributor())
    e.register(new WikilinkContributor())
    e.register(new HeadingContributor())
    e.onYjsChange(ytext, doc, 'doc1')

    expect(e.index.getByValue('hashtags', '#todo')).toHaveLength(1)
    expect(e.index.getByValue('wikilinks', 'Ref')).toHaveLength(1)
    expect(e.index.getByValue('headings', 'My Note')).toHaveLength(1)
  })
})

describe('E2 — contributors are isolated: one namespace does not pollute another', () => {
  it('getByValue scoped to namespace returns only that contributor entries', () => {
    const { doc, ytext } = makeDoc('[[Notes]] #Notes')
    const e = new IndexEngine()
    e.register(new HashtagContributor())
    e.register(new WikilinkContributor())
    e.onYjsChange(ytext, doc, 'doc1')

    // Same word "Notes" appears as both a wikilink target and a hashtag
    expect(e.index.getByValue('hashtags', '#Notes')).toHaveLength(1)
    expect(e.index.getByValue('wikilinks', 'Notes')).toHaveLength(1)
    expect(e.index.getByValue('hashtags', 'Notes')).toHaveLength(0)   // no cross-contamination
  })
})

describe('E3 — metadata contributor coexists with anchored contributors', () => {
  it('filename and hashtag entries live in the same index store', () => {
    const { doc, ytext } = makeDoc('#todo fix this')
    const e = new IndexEngine()
    e.register(new HashtagContributor())
    e.registerMetadata(new FilenameContributor())

    e.onYjsChange(ytext, doc, 'doc1')
    e.onPathChange('doc1', 'tasks/Todo.md')

    expect(e.index.getByValue('hashtags', '#todo')).toHaveLength(1)
    expect(e.index.getByValue('filename', 'Todo')).toHaveLength(1)
    expect(e.index.size).toBe(2)
  })
})
