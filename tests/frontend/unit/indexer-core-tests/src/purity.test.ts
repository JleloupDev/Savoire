// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le coeur du noyau tourne partout (Node, Worker du navigateur, bureau) :
// aucune API Node ni DOM hors de l'entree src/node. Seules dependances :
// plugin-api, domain-index, yjs.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(__dirname, '../../../../../packages/indexer-core/src')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : []
  })
}

describe('purete du coeur', () => {
  const core = files(SRC).filter(f => !relative(SRC, f).startsWith('node'))

  it('ni API Node, ni DOM', () => {
    const forbidden = [
      /from ['"]node:/, /require\(/, /\bprocess\./, /\bBuffer\b/, /\b__dirname\b/,
      /\bwindow\./, /\bdocument\./, /\blocalStorage\b/, /\bnavigator\./, /\bHTMLElement\b/,
    ]
    for (const f of core) {
      const text = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      for (const re of forbidden) expect([relative(SRC, f), re.test(text)]).toEqual([relative(SRC, f), false])
    }
  })

  it('dependances : plugin-api, domain-index, yjs', () => {
    const allowed = new Set(['@savoire/plugin-api', '@savoire/domain-index', 'yjs'])
    for (const f of core) {
      for (const m of readFileSync(f, 'utf8').matchAll(/from ['"]([^'"]+)['"]/g)) {
        if (m[1].startsWith('.')) continue
        expect([relative(SRC, f), m[1], allowed.has(m[1])]).toEqual([relative(SRC, f), m[1], true])
      }
    }
  })
})
