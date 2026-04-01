// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultPlugin, PluginAPI } from '@savoire/plugin-api'
import { marked } from 'marked'

const FULL_EMBED_RE = /^\s*!\[\[([^\]]+)\]\]\s*$/
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'])

interface EmbedData {
  raw: string
  targetPath: string
}

// Parse YAML-ish frontmatter to strip it before rendering
function parseFrontmatter(source: string): { body: string } {
  const match = source.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/)
  return { body: match ? match[1] : source }
}

function parseEmbedTarget(raw: string): EmbedData {
  const source = raw.trim()
  const noAlias = source.split('|', 1)[0].trim()
  const noHeading = noAlias.split('#', 1)[0].trim()
  return { raw: source, targetPath: noHeading }
}

function parseEmbedBlock(blockText: string): EmbedData | null {
  const match = String(blockText).match(FULL_EMBED_RE)
  if (!match) return null
  return parseEmbedTarget(match[1])
}

function normalizeEmbedData(input: unknown): EmbedData {
  if (typeof input === 'string') {
    return parseEmbedBlock(input) ?? parseEmbedTarget(input)
  }
  if (input && typeof input === 'object') {
    const raw = 'raw' in input && typeof input.raw === 'string' ? input.raw : ''
    const targetPath = 'targetPath' in input && typeof input.targetPath === 'string'
      ? input.targetPath
      : parseEmbedTarget(raw).targetPath
    return { raw, targetPath }
  }
  return { raw: '', targetPath: '' }
}

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-note-embed',
    name: 'Note Embeds',
    version: '1.0.0',
    permissions: ['ui:editor', 'vault:read'],
    defaultActive: true,
  },

  async onload(api: PluginAPI) {
    for (const ext of IMAGE_EXTS) {
      api.files.register({
        extension: ext,
        label: 'Image',
        icon: '🖼',
        create: async () => { throw new Error('Cannot create image files') },
        open: (path) => {
          let container: HTMLElement | null = null
          return {
            mount(el: HTMLElement) {
              container = el
              el.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;overflow:auto;padding:24px;box-sizing:border-box'
              const url = api.vault.resolveAttachmentUrl?.(path) ?? ''
              const img = document.createElement('img')
              img.src = url
              img.alt = path.split('/').at(-1) ?? path
              img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;border-radius:6px'
              el.appendChild(img)
            },
            destroy() {
              if (container) container.innerHTML = ''
            },
          }
        },
      })
    }

    api.triggers.register({ id: 'note-embed', character: '![[', description: 'Note embed lecture seule' })

    api.blocks.register({
      type: 'note-embed',
      trigger: {
        id: 'note-embed',
        label: 'Intégrer une note',
        description: 'Embed lecture seule ![[...]]',
        icon: '📄',
        category: 'Embeds',
        insert: '![[chemin/fichier.md]]',
      },

      // K1 — read-only embed: ![[filename]]
      detect: (text) => parseEmbedBlock(text) !== null,

      deserialize(raw) {
        return parseEmbedBlock(String(raw)) ?? parseEmbedTarget('')
      },

      serialize(data) {
        const embed = normalizeEmbedData(data)
        return `![[${embed.raw}]]`
      },

      createEditorWidget: (_data, _ctx) => ({
        mount: (_el) => {},
        destroy: () => {},
      }),

      renderClient(data, _ctx) {
        const { raw, targetPath } = normalizeEmbedData(data)

        if (!targetPath) {
          const err = document.createElement('span')
          err.textContent = '⚠ Invalid embed path'
          return err
        }

        const ext = targetPath.split('.').at(-1)?.toLowerCase() ?? ''
        if (IMAGE_EXTS.has(ext)) {
          const url = api.vault.resolveAttachmentUrl?.(targetPath) ?? ''
          const img = document.createElement('img')
          img.src = url
          img.alt = targetPath.split('/').at(-1) ?? targetPath
          img.style.cssText = 'max-width:100%;border-radius:4px;display:block'
          return img
        }

        const container = document.createElement('div')
        container.className = 'note-embed'
        container.style.cssText =
          'border:1px solid #dddcd5;border-radius:6px;padding:10px 14px;margin:6px 0;background:#fafaf8'

        const header = document.createElement('div')
        header.className = 'note-embed-header'
        header.style.cssText =
          'font-size:11px;color:#aaa;margin-bottom:6px;display:flex;align-items:center;gap:6px'
        header.innerHTML = `<span>📄</span><span>${raw}</span>`
        container.appendChild(header)

        const body = document.createElement('div')
        body.className = 'note-embed-body'
        body.style.cssText = 'font-size:13px'
        body.textContent = 'Loading…'
        container.appendChild(body)

        // K1: read-only markdown preview
        api.vault.readDocumentByPath(targetPath).then((source) => {
          const { body: mdBody } = parseFrontmatter(source)
          const html = String(marked.parse(mdBody))
          body.innerHTML = html
        }).catch(() => {
          body.textContent = `⚠ Could not load "${targetPath}"`
        })

        return container
      },
    })
  },

  async onunload() {},
}
export default plugin
