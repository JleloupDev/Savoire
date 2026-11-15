// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Garde-fou (revue du 14/11/2026, C2) : le Markdown laisse passer le HTML
// brut d'une note. Tout fichier qui rend du Markdown (marked.parse,
// marked.parseInline) doit donc aussi nettoyer ce qu'il affiche
// (sanitizeHtml). Un nouveau rendu sans nettoyage fait echouer ce test.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../..')

function sources(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) sources(full, acc)
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|d)\.tsx?$/.test(e.name)) acc.push(full)
  }
  return acc
}

describe('rendu Markdown', () => {
  it('tout fichier qui rend du Markdown nettoie le HTML', () => {
    const files = [...sources(path.join(repo, 'packages')), ...sources(path.join(repo, 'apps'))]
    const renderers = files.filter(f => /\bmarked\.(parse|parseInline)\(/.test(readFileSync(f, 'utf8')))
    expect(renderers.length).toBeGreaterThan(0)
    const unsafe = renderers.filter(f => !readFileSync(f, 'utf8').includes('sanitizeHtml('))
    expect(unsafe.map(f => path.relative(repo, f))).toEqual([])
  })
})
