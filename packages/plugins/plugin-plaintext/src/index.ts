// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// plugin-plaintext — POC d'intégration du système FileTypeSpec.
// Enregistre l'extension ".txt" avec :
//   - open()        : éditeur textarea simple (pas de CRDT, save REST pur)
//   - renderEmbed() : aperçu read-only en majuscules (marqueur visuel du POC)
//

import type { VaultPlugin, PluginAPI, FileContext, FileView } from '@savoire/plugin-api'

const SAVE_DEBOUNCE_MS = 1500

function createPlaintextView(path: string, ctx: FileContext): FileView {
  const vault = ctx.vault
  let textarea: HTMLTextAreaElement | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let destroyed = false

  function scheduleSave(content: string) {
    if (saveTimer !== null) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (destroyed || !vault) return
      const docId = vault.resolveDocumentId(path)
      if (!docId) { console.warn('[plugin-plaintext] docId introuvable pour', path); return }
      vault.write(docId, content).catch(err => console.error('[plugin-plaintext] save error', err))
    }, SAVE_DEBOUNCE_MS)
  }

  return {
    mount(container: HTMLElement) {
      container.innerHTML = ''
      container.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--bg-base,#1e1e2e)'

      // ── Textarea ─────────────────────────────────────────────────────────────
      textarea = document.createElement('textarea')
      textarea.style.cssText = [
        'flex:1', 'resize:none', 'border:none', 'outline:none',
        'padding:16px 20px', 'font-family:monospace', 'font-size:14px',
        'line-height:1.6', 'background:var(--bg-base,#1e1e2e)',
        'color:var(--text,#cdd6f4)', 'text-transform:uppercase',
      ].join(';')
      textarea.placeholder = 'CONTENU DU FICHIER TEXTE…'
      textarea.disabled = true
      container.appendChild(textarea)

      // saveStatus affiché dans le placeholder / title — pas de header séparé
      const saveStatus = { set textContent(v: string) { if (textarea) textarea.title = v } }

      // ── Chargement initial ───────────────────────────────────────────────────
      ;(async () => {
        if (!vault) { saveStatus.textContent = '⚠ Vault indisponible'; return }
        try {
          const content = await vault.readDocumentByPath(path)
          if (destroyed || !textarea) return
          textarea.value = content
          textarea.disabled = false
          saveStatus.textContent = '✓ Synchronisé'
        } catch (err) {
          if (destroyed || !textarea) return
          saveStatus.textContent = '⚠ Erreur de chargement'
          console.error('[plugin-plaintext] load error', err)
        }
      })()

      // ── Handlers ─────────────────────────────────────────────────────────────
      textarea.addEventListener('input', () => {
        if (!textarea) return
        saveStatus.textContent = '…'
        scheduleSave(textarea.value)
        saveStatus.textContent = 'Modification…'
      })

      // Ctrl+S / Cmd+S : sauvegarde immédiate
      textarea.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
          e.preventDefault()
          if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null }
          if (!vault || !textarea) return
          const docId = vault.resolveDocumentId(path)
          if (!docId) return
          saveStatus.textContent = 'Sauvegarde…'
          vault.write(docId, textarea.value)
            .then(() => { if (!destroyed) saveStatus.textContent = '✓ Sauvegardé' })
            .catch(() => { if (!destroyed) saveStatus.textContent = '⚠ Erreur save' })
        }
      })

      // Flush le timer au blur
      textarea.addEventListener('blur', () => {
        if (saveTimer !== null) {
          clearTimeout(saveTimer)
          saveTimer = null
          if (!vault || !textarea) return
          const docId = vault.resolveDocumentId(path)
          if (!docId) return
          vault.write(docId, textarea.value)
            .then(() => { if (!destroyed) saveStatus.textContent = '✓ Synchronisé' })
            .catch(() => { if (!destroyed) saveStatus.textContent = '⚠ Erreur save' })
        }
      })
    },

    destroy() {
      destroyed = true
      if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null }
      if (textarea?.parentElement) textarea.parentElement.innerHTML = ''
      textarea = null
    },
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-plaintext',
    name: 'Plaintext Editor',
    version: '0.0.1',
    description: 'Éditeur textarea simple pour les fichiers .txt — POC FileTypeSpec',
    permissions: ['ui:editor', 'vault:read', 'vault:write'],
  },

  async onload(api: PluginAPI) {
    api.files.register({
      extension: 'txt',
      label: 'Texte brut',
      icon: '📄',

      create: async () => '',

      open: (path: string, ctx: FileContext) => createPlaintextView(path, ctx),

      renderEmbed: async (path: string, ctx: FileContext): Promise<HTMLElement> => {
        const wrapper = document.createElement('div')
        wrapper.style.cssText = [
          'border:1px solid var(--border,#313244)',
          'border-left:3px solid var(--color-info,#89b4fa)',
          'border-radius:4px',
          'padding:8px 12px',
          'margin:4px 0',
          'background:var(--bg-elevated,#313244)',
          'font-family:monospace',
          'font-size:12px',
        ].join(';')

        const headerEl = document.createElement('div')
        headerEl.style.cssText = 'font-size:10px;color:var(--text-faint,#6c7086);margin-bottom:6px'
        headerEl.textContent = `📄 ${path.split('/').at(-1) ?? path}  (texte brut)`
        wrapper.appendChild(headerEl)

        const contentEl = document.createElement('pre')
        contentEl.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word;color:var(--text,#cdd6f4);text-transform:uppercase'
        contentEl.textContent = '…'
        wrapper.appendChild(contentEl)

        if (ctx.vault) {
          ctx.vault.readDocumentByPath(path)
            .then(text => { contentEl.textContent = text.toUpperCase() })
            .catch(() => { contentEl.textContent = '⚠ Impossible de charger' })
        }

        return wrapper
      },
    })
  },

  async onunload() {},
}

export default plugin
