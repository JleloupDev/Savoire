// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// plugin-mermaid: renders Mermaid diagrams in two syntaxes:
//   1. Fenced code block:  ```mermaid\n...\n```
//   2. Obsidian callout:   > [!MERMAID]\n> ...
//

import type { VaultPlugin, PluginAPI } from '@savoire/plugin-api'
import mermaid from 'mermaid'

let initialized = false
let counter = 0

function ensureInit(): void {
  if (initialized) return
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'loose',
  })
  initialized = true
}

async function renderDiagram(definition: string): Promise<string> {
  ensureInit()
  const id = `poc-mermaid-${++counter}`
  const { svg } = await mermaid.render(id, definition)
  return svg
}

// ── Détection ──────────────────────────────────────────────────────────────
const FENCE_RE  = /^```mermaid\n([\s\S]*?)\n?```\s*$/
const CALLOUT_RE = /^>\s*\[!MERMAID\]/i

interface MermaidData { definition: string; source: 'fence' | 'callout' }

// ── Plugin ─────────────────────────────────────────────────────────────────
const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-mermaid',
    name: 'Mermaid Diagrams',
    version: '0.0.1',
    description: 'Rendu de diagrammes Mermaid dans l\'éditeur',
    permissions: ['ui:editor'],
    defaultActive: true,
  },

  async onload(api: PluginAPI) {
    api.blocks.register({
      type: 'mermaid',

      // Slash command entries — insérables depuis la palette (/)
      trigger: [
        {
          id: 'mermaid-flowchart',
          label: 'Flowchart Mermaid',
          description: 'Diagramme de flux (graph TD)',
          icon: '◈',
          category: 'Diagrammes',
          insert: '```mermaid\ngraph TD\n  A[Début] --> B{Condition}\n  B -->|Oui| C[Résultat]\n  B -->|Non| D[Autre]\n```',
        },
        {
          id: 'mermaid-sequence',
          label: 'Séquence Mermaid',
          description: 'Diagramme de séquence (sequenceDiagram)',
          icon: '◈',
          category: 'Diagrammes',
          insert: '```mermaid\nsequenceDiagram\n  Alice->>Bob: Message\n  Bob-->>Alice: Réponse\n```',
        },
        {
          id: 'mermaid-callout',
          label: 'Callout Mermaid',
          description: 'Diagramme Mermaid en callout Obsidian (> [!MERMAID])',
          icon: '◈',
          category: 'Diagrammes',
          insert: '> [!MERMAID]\n> graph TD\n>   A --> B',
        },
      ],

      detect: (text: string) => FENCE_RE.test(text.trim()) || CALLOUT_RE.test(text),

      deserialize: (raw: string): MermaidData => {
        const text = String(raw)
        const fenceMatch = text.trim().match(FENCE_RE)
        if (fenceMatch) {
          return { definition: fenceMatch[1] ?? '', source: 'fence' }
        }
        // Callout: strip "> " prefix from every line after the header
        const definition = text
          .split('\n')
          .slice(1)
          .map(l => l.replace(/^>\s?/, ''))
          .join('\n')
          .trim()
        return { definition, source: 'callout' }
      },

      serialize: (data: unknown): string => {
        const d = data as MermaidData
        if (d.source === 'callout') {
          const lines = d.definition.split('\n').map(l => `> ${l}`)
          return `> [!MERMAID]\n${lines.join('\n')}`
        }
        return `\`\`\`mermaid\n${d.definition}\n\`\`\``
      },

      createEditorWidget: (_data, _ctx) => ({ mount: (_el) => {}, destroy: () => {} }),

      renderClient: (data, _ctx) => {
        const { definition } = data as MermaidData

        const wrapper = document.createElement('div')
        wrapper.style.cssText = [
          'padding:12px 4px',
          'text-align:center',
          'min-height:48px',
          'display:flex',
          'align-items:center',
          'justify-content:center',
        ].join(';')

        // Placeholder pendant le render async
        const placeholder = document.createElement('span')
        placeholder.style.cssText = 'font-size:12px;color:#585b70;font-family:monospace'
        placeholder.textContent = '⏳ Mermaid…'
        wrapper.appendChild(placeholder)

        renderDiagram(definition).then((svg) => {
          wrapper.innerHTML = svg
          const svgEl = wrapper.querySelector('svg')
          if (svgEl) {
            svgEl.style.maxWidth = '100%'
            svgEl.style.height = 'auto'
          }
        }).catch((err: unknown) => {
          wrapper.style.cssText = 'padding:8px 12px;border-left:3px solid #ef4444;background:rgba(239,68,68,0.08);border-radius:4px;margin:4px 0'
          wrapper.style.textAlign = 'left'
          const msg = err instanceof Error ? err.message : String(err)
          wrapper.innerHTML = `<span style="color:#ef4444;font-size:12px;font-family:monospace">Mermaid error: ${escapeHtml(msg)}</span>`
        })

        return wrapper
      },
    })
  },

  async onunload() {},
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export default plugin
