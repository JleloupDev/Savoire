// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Garde-fou (revue du 14/11/2026, M4) : la page de l'application ne charge
// rien d'un autre domaine. Les polices sont servies par l'application ;
// chaque fichier cite par fonts.css existe.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const web = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../../apps/web')

describe('aucun chargement depuis un autre domaine', () => {
  it('index.html ne cite aucune adresse externe', () => {
    const html = readFileSync(path.join(web, 'index.html'), 'utf8')
    expect(html.match(/(?:href|src)\s*=\s*["'](?:https?:)?\/\/[^"']+/gi) ?? []).toEqual([])
  })

  it('les polices sont locales, et chaque fichier existe', () => {
    const css = readFileSync(path.join(web, 'public/fonts/fonts.css'), 'utf8')
    const urls = [...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map(m => m[1])
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.filter(u => !u.startsWith('/fonts/'))).toEqual([])
    expect(urls.filter(u => !existsSync(path.join(web, 'public', u)))).toEqual([])
    for (const family of ['Inter', 'Source Serif 4', 'JetBrains Mono']) expect(css).toContain(`font-family: '${family}'`)
  })
})
