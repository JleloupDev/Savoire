// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// plugin-office — documents Office lies : Word, Excel, PowerPoint, OpenDocument.
//
// Le document du vault est un lien vers sa version en ligne. « Ouvrir » mene a
// l'editeur du service (Microsoft 365, Google, Collabora...), qui gere la
// collaboration et applique ses propres droits. Savoire ne lit pas le contenu :
// rien a indexer au-dela du nom, rien a exposer aux membres du vault.
//
// Pas de verrou (mode 'none') : le lien change rarement, et l'edition se fait
// ailleurs.

import { createIcon } from '@savoire/plugin-api'
import type { VaultPlugin, PluginAPI, FileContext, FileView, DocumentRoom, VaultAPI, ExtractorSpec } from '@savoire/plugin-api'
import { describeLink, normalizeUrl, parseOfficeLink, serializeOfficeLink, type OfficeLink } from './state'

export { describeLink, normalizeUrl, parseOfficeLink, serializeOfficeLink } from './state'
export type { OfficeLink, LinkDescription } from './state'

// Une famille d'icones par usage, quel que soit l'editeur : bleu = texte,
// vert = tableur, orange = presentation (le code couleur des suites bureautiques).
export const OFFICE_TYPES = [
  { extension: 'docx', label: 'Document Word', icon: 'file-text' },
  { extension: 'xlsx', label: 'Classeur Excel', icon: 'file-spreadsheet' },
  { extension: 'pptx', label: 'Présentation PowerPoint', icon: 'presentation' },
  { extension: 'odt', label: 'Texte OpenDocument', icon: 'file-text' },
  { extension: 'ods', label: 'Classeur OpenDocument', icon: 'file-spreadsheet' },
  { extension: 'odp', label: 'Présentation OpenDocument', icon: 'presentation' },
] as const

// ── Styles ────────────────────────────────────────────────────────────────────

const CARD = [
  'max-width:520px', 'margin:48px auto', 'padding:24px',
  'border:1px solid var(--border,#313244)', 'border-radius:8px',
  'font-family:var(--font-ui,sans-serif)', 'color:var(--text,#cdd6f4)',
  'display:flex', 'flex-direction:column', 'gap:14px',
].join(';')
const MUTED = 'font-size:13px;color:var(--text-muted,#a6adc8)'
const BUTTON = [
  'padding:7px 14px', 'border-radius:6px', 'border:1px solid var(--border,#313244)',
  'background:transparent', 'color:inherit', 'font:inherit', 'font-size:13px',
  'cursor:pointer', 'text-decoration:none', 'display:inline-block',
].join(';')
const INPUT = [
  'flex:1', 'min-width:0', 'padding:7px 10px', 'border-radius:6px',
  'border:1px solid var(--border,#313244)', 'background:transparent',
  'color:inherit', 'font:inherit', 'font-size:13px',
].join(';')

// ── FileView ──────────────────────────────────────────────────────────────────

function createOfficeView(
  path: string,
  type: (typeof OFFICE_TYPES)[number],
  ctx: FileContext,
  sync: PluginAPI['sync'],
  icons?: PluginAPI['icons'],
  extractors?: PluginAPI['extractors'],
): FileView {
  const vault: VaultAPI | undefined = ctx.vault
  const docName = path.split('/').at(-1) ?? path

  let container: HTMLElement | null = null
  let link: OfficeLink | null = null
  let readOnly = !!ctx.readOnly
  let editing = false
  let error: string | null = null
  let room: DocumentRoom | null = null
  let unsubRoom: (() => void) | null = null
  let generation = 0
  // Un vrai fichier Office (dossier du poste), pas un lien : son apercu.
  let preview: HTMLElement | null = null

  function render(): void {
    if (!container) return
    container.innerHTML = ''
    if (preview) {
      const banner = document.createElement('div')
      banner.dataset.testid = 'office-preview-banner'
      banner.style.cssText = 'padding:6px 14px;font:12px var(--font-ui,sans-serif);color:var(--text-muted,#64748b);border-bottom:1px solid var(--border,#e2e8f0);display:flex;align-items:center;gap:6px'
      banner.append(createIcon(icons, type.icon, { size: 14 }), `${type.label} · aperçu en lecture seule : il se modifie dans son logiciel.`)
      const body = document.createElement('div')
      body.dataset.testid = 'office-preview'
      body.style.cssText = 'height:calc(100% - 31px);overflow:auto'
      body.appendChild(preview)
      container.append(banner, body)
      return
    }
    const card = document.createElement('div')
    card.style.cssText = CARD
    card.dataset.testid = 'office-card'

    const title = document.createElement('div')
    title.style.cssText = 'font-size:16px;font-weight:600;display:flex;align-items:center;gap:8px'
    title.append(createIcon(icons, type.icon, { size: 18 }), docName)
    card.appendChild(title)

    if (link && !editing) {
      const { service, openLabel } = describeLink(link, type.extension)
      const where = document.createElement('div')
      where.style.cssText = MUTED
      where.dataset.testid = 'office-service'
      where.textContent = `${type.label} en ligne · ${service}`
      card.appendChild(where)

      const actions = document.createElement('div')
      actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap'
      const open = document.createElement('a')
      open.style.cssText = BUTTON
      open.dataset.testid = 'office-open'
      open.textContent = openLabel
      open.href = link.url
      open.target = '_blank'
      // Le service ouvert ne doit pas pouvoir piloter l'onglet Savoire.
      open.rel = 'noopener noreferrer'
      actions.appendChild(open)
      if (!readOnly) {
        const change = document.createElement('button')
        change.style.cssText = BUTTON
        change.dataset.testid = 'office-change'
        change.textContent = 'Changer le lien'
        change.addEventListener('click', () => { editing = true; render() })
        actions.appendChild(change)
      }
      card.appendChild(actions)
    } else if (readOnly) {
      const empty = document.createElement('div')
      empty.style.cssText = MUTED
      empty.textContent = 'Ce document n’est lié à aucun document en ligne.'
      card.appendChild(empty)
    } else {
      card.appendChild(linkForm())
    }

    if (error) {
      const m = document.createElement('div')
      m.dataset.testid = 'office-error'
      m.style.cssText = 'font-size:13px;color:var(--danger,#f38ba8)'
      m.textContent = error
      card.appendChild(m)
    }

    container.appendChild(card)
  }

  function linkForm(): HTMLElement {
    const form = document.createElement('form')
    form.style.cssText = 'display:flex;flex-direction:column;gap:8px'
    const hint = document.createElement('div')
    hint.style.cssText = MUTED
    hint.textContent = 'Collez le lien de partage du document (OneDrive, SharePoint, Google Drive, Collabora…).'
    form.appendChild(hint)
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:8px'
    const input = document.createElement('input')
    input.type = 'url'
    input.placeholder = 'https://…'
    input.style.cssText = INPUT
    input.dataset.testid = 'office-url'
    input.value = link?.url ?? ''
    row.appendChild(input)
    const submit = document.createElement('button')
    submit.type = 'submit'
    submit.style.cssText = BUTTON
    submit.dataset.testid = 'office-link'
    submit.textContent = 'Lier'
    row.appendChild(submit)
    form.appendChild(row)
    if (editing) {
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.style.cssText = BUTTON + ';align-self:flex-start'
      cancel.textContent = 'Annuler'
      cancel.addEventListener('click', () => { editing = false; error = null; render() })
      form.appendChild(cancel)
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      void save(input.value)
    })
    return form
  }

  async function save(input: string): Promise<void> {
    if (readOnly || !vault) return
    const url = normalizeUrl(input)
    if (!url) { error = 'Lien invalide : il doit commencer par https://'; render(); return }
    const next: OfficeLink = { url }
    try {
      const json = serializeOfficeLink(next)
      if (room) {
        await room.pushSnapshot(json)
      } else {
        const docId = vault.resolveDocumentId(path)
        if (!docId) throw new Error('document introuvable dans le vault')
        await vault.write(docId, json)
      }
      link = next
      editing = false
      error = null
    } catch (err) {
      error = `Échec de l’enregistrement : ${err instanceof Error ? err.message : String(err)}`
    }
    render()
  }

  return {
    mount(el: HTMLElement) {
      const myGen = ++generation
      container = el
      el.style.cssText = 'height:100%;width:100%;overflow:auto'
      render()

      ;(async () => {
        if (vault) {
          try {
            link = parseOfficeLink(await vault.readDocumentByPath(path))
          } catch {
            error = 'Impossible de lire le lien.'
          }
          // Pas un lien : peut-etre le fichier lui-meme (une archive « PK »).
          if (!link) {
            const bytes = await vault.readBinary?.(path).catch(() => null)
            const spec = extractors?.forPath(path)
            if (bytes && bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && spec) {
              try {
                preview = spec.preview ? await spec.preview(bytes, { path }) : await genericOfficePreview(spec, bytes, path)
              } catch (err) {
                error = `Aperçu impossible : ${err instanceof Error ? err.message : String(err)}`
              }
              readOnly = true
            }
          }
        }
        if (generation !== myGen) return
        render()
        if (preview) return

        // Un lien change par un autre membre arrive ici, sans recharger.
        const docId = vault?.resolveDocumentId(path)
        if (!sync || !docId) return
        try {
          const opened = await sync.openRoom(ctx.vaultId, docId, ctx.userId ?? 'anonymous')
          if (generation !== myGen) { void opened.close(); return }
          room = opened
          unsubRoom = opened.onSnapshot((json) => {
            link = parseOfficeLink(json)
            render()
          })
        } catch (err) {
          console.warn('[plugin-office] synchro indisponible', err)
        }
      })()
    },

    setReadOnly(next: boolean) {
      readOnly = next
      render()
    },

    destroy() {
      generation++
      unsubRoom?.(); unsubRoom = null
      void room?.close(); room = null
      if (container) container.innerHTML = ''
      container = null
    },
  }
}

/** Apercu du contenu extrait (titre, sections, tableaux), sans le plugin Documents. */
async function genericOfficePreview(spec: ExtractorSpec, bytes: Uint8Array, path: string): Promise<HTMLElement> {
  const content = await spec.extract(bytes, { path })
  const root = document.createElement('div')
  root.style.cssText = 'max-width:860px;margin:0 auto;padding:24px 32px;font:15px/1.6 var(--font-editor,Georgia,serif);color:var(--text,#1e293b)'
  if (content.title) { const h = document.createElement('h1'); h.textContent = content.title; root.appendChild(h) }
  for (const s of content.sections) {
    if (s.heading) { const h = document.createElement('h2'); h.textContent = s.heading; root.appendChild(h) }
    for (const line of s.text.split('\n')) if (line.trim()) { const p = document.createElement('p'); p.style.whiteSpace = 'pre-wrap'; p.textContent = line; root.appendChild(p) }
  }
  return root
}

// ── Plugin ────────────────────────────────────────────────────────────────────

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-office',
    scope: 'vault',
    name: 'Documents Office liés',
    version: '0.0.1',
    description: 'Word, Excel, PowerPoint et OpenDocument : un lien vers le document en ligne',
    permissions: ['ui:editor', 'vault:read', 'vault:write'],
    defaultActive: true,
  },

  async onload(api: PluginAPI) {
    for (const type of OFFICE_TYPES) {
      api.files.register({
        extension: type.extension,
        label: type.label,
        icon: type.icon,
        collaborationMode: 'none',
        // Document vide : le lien se colle depuis la fiche.
        create: async () => '',
        open: (path: string, ctx: FileContext) => createOfficeView(path, type, ctx, api.sync, api.icons, api.extractors),
      })
    }
  },

  async onunload() {},
}

export default plugin
