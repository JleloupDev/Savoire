// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Export PDF : la note entiere rendue bloc par bloc, les blocs des plugins
// avec leur rendu, sans le frontmatter, avec le titre en tete.
import { describe, it, expect } from 'vitest'
import { renderNoteForPrint } from '../../../../../packages/editor-core/src/PdfExport'
import type { BlockRegistry, BlockSpec } from '@savoire/plugin-api'

function registry(): BlockRegistry {
  const spec = (type: string, re: RegExp): BlockSpec => ({
    type, detect: re, serialize: d => String(d), deserialize: r => r,
    createEditorWidget: () => ({ mount() {}, destroy() {} }),
    renderClient: () => { const el = document.createElement('div'); el.className = `rendu-${type}`; return el },
  })
  const specs = [spec('demo', /^```demo/), spec('code-block', /^```js/)]
  return {
    register() {}, unregister() {}, getAll: () => specs,
    detectBlock: (text: string) => {
      const s = specs.find(x => (x.detect as RegExp).test(text))
      return s ? { type: s.type, spec: s } : null
    },
  }
}

describe('export PDF', () => {
  it('rend toute la note, blocs de plugins compris', () => {
    const el = renderNoteForPrint('---\nstatut: ok\n---\n## Titre\n\nTexte **gras**\n\n```demo\nx\n```\n\n```js\nconst a = 1\n```\n', { title: 'Rapport', registry: registry() })
    expect(el.querySelector('.savoire-print-title')!.textContent).toBe('Rapport')
    expect(el.textContent).not.toContain('statut')
    expect(el.querySelector('h2')!.textContent).toBe('Titre')
    expect(el.querySelector('strong')!.textContent).toBe('gras')
    expect(el.querySelector('.rendu-demo')).not.toBeNull()
    // Le code s'imprime en Markdown simple (pas le fond sombre de l'editeur).
    expect(el.querySelector('.rendu-code-block')).toBeNull()
    expect(el.querySelector('pre')!.textContent).toContain('const a = 1')
  })
})
