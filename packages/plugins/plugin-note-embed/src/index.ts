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

interface EmbedElements {
  container: HTMLDivElement
  body: HTMLDivElement
  rawSpan: HTMLSpanElement
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
    // DECISION: WeakMap keyed on BlockContext (unique object per EditorCore instance).
    // PluginWidget.eq() in LivePreview returns true for same embed text, causing CodeMirror
    // to reuse the old DOM element and discard the new one produced by renderClient.
    // By caching the same container object per (editorInstance, targetPath), the async
    // vault read always updates the element that IS in the DOM, regardless of eq() behavior.
    const containerCache = new WeakMap<object, Map<string, EmbedElements>>()

    for (const ext of IMAGE_EXTS) {
      api.files.register({
        extension: ext,
        label: 'Image',
        icon: '🖼',
        creatable: false,
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

      renderClient(data, ctx) {
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

        // DECISION: reuse cached elements per (editorInstance, targetPath).
        // PluginWidget.eq() returns true when the embed text is unchanged, causing
        // CodeMirror to keep the OLD DOM element and discard the new one returned here.
        // By returning the same object, the async vault read below always updates
        // the element that is actually mounted in the DOM.
        let instanceCache = containerCache.get(ctx)
        if (!instanceCache) {
          instanceCache = new Map()
          containerCache.set(ctx, instanceCache)
        }

        let els = instanceCache.get(targetPath)
        if (!els) {
          const container = document.createElement('div') as HTMLDivElement
          container.className = 'note-embed'
          container.style.cssText =
            'border:1px solid #dddcd5;border-radius:6px;padding:10px 14px;margin:6px 0;background:#fafaf8'

          const header = document.createElement('div')
          header.className = 'note-embed-header'
          header.style.cssText =
            'font-size:11px;color:#aaa;margin-bottom:6px;display:flex;align-items:center;gap:6px'
          const rawSpan = document.createElement('span') as HTMLSpanElement
          rawSpan.textContent = raw
          header.appendChild(document.createElement('span')).textContent = '📄'
          header.appendChild(rawSpan)
          container.appendChild(header)

          const body = document.createElement('div') as HTMLDivElement
          body.className = 'note-embed-body'
          body.style.cssText = 'font-size:13px'
          body.textContent = 'Loading…'
          container.appendChild(body)

          els = { container, body, rawSpan }
          instanceCache.set(targetPath, els)
        } else {
          // Update the displayed raw path in case alias changed (e.g. ![[file|alias]])
          els.rawSpan.textContent = raw
        }

        const { container, body } = els

        // K1: read-only markdown preview
        // DECISION: run beforeParse hooks so wikilinks and other plugin syntax
        // are resolved in the embedded content (same pipeline as LivePreview fallback).
        // Fresh fetch on every renderClient call — because the same container object
        // is returned regardless of whether eq() causes CodeMirror to reuse it,
        // the update is always visible in the DOM.
        void (async () => {
          try {
            const source = await api.vault.readDocumentByPath(targetPath)
            const { body: mdBody } = parseFrontmatter(source)
            const preprocessed = await api.hooks.runBeforeParse(mdBody)
            body.innerHTML = String(marked.parse(preprocessed))
          } catch {
            body.textContent = `⚠ Could not load "${targetPath}"`
          }
        })()

        return container
      },
    })
  },

  async onunload() {},
}
export default plugin
