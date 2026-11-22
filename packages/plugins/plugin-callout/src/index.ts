// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultPlugin, PluginAPI, BlockContext, BlockEditContext } from '@savoire/plugin-api'
import { createIcon } from '@savoire/plugin-api'

interface CalloutData { type: string; content: string; title?: string }

const COLORS: Record<string, { border: string; bg: string; icon: string }> = {
  NOTE:    { border: '#3b82f6', bg: 'rgba(59,130,246,0.08)',  icon: 'pencil' },
  INFO:    { border: '#3b82f6', bg: 'rgba(59,130,246,0.08)',  icon: 'info' },
  TIP:     { border: '#22c55e', bg: 'rgba(34,197,94,0.08)',   icon: 'flame' },
  SUCCESS: { border: '#22c55e', bg: 'rgba(34,197,94,0.08)',   icon: 'check' },
  WARNING: { border: '#f59e0b', bg: 'rgba(245,158,11,0.08)',  icon: 'triangle-alert' },
  CAUTION: { border: '#f59e0b', bg: 'rgba(245,158,11,0.08)',  icon: 'triangle-alert' },
  DANGER:  { border: '#ef4444', bg: 'rgba(239,68,68,0.08)',   icon: 'zap' },
  BUG:     { border: '#ef4444', bg: 'rgba(239,68,68,0.08)',   icon: 'bug' },
  TODO:    { border: '#a855f7', bg: 'rgba(168,85,247,0.08)',  icon: 'circle-check' },
  QUESTION:{ border: '#06b6d4', bg: 'rgba(6,182,212,0.08)',   icon: 'circle-help' },
}
const DEFAULT = { border: '#3b82f6', bg: 'rgba(59,130,246,0.08)', icon: 'pencil' }

/** Noms affiches des types (le Markdown garde le nom anglais : > [!TIP]). */
const LABELS: Record<string, string> = {
  NOTE: 'Note', INFO: 'Info', TIP: 'Conseil', SUCCESS: 'Succès', WARNING: 'Avertissement',
  CAUTION: 'Attention', DANGER: 'Danger', BUG: 'Bug', TODO: 'À faire', QUESTION: 'Question',
}

function serializeCallout(d: CalloutData): string {
  const lines = d.content.split('\n').map(l => (l ? `> ${l}` : '>'))
  return `> [!${d.type.toUpperCase()}]${d.title ? ` ${d.title}` : ''}\n${lines.join('\n')}`
}

function deserializeCallout(raw: string): CalloutData {
  const match = String(raw).match(/\[!(\w+)\]/)
  const title = /^>\s*\[!\w+\][+-]?[ \t]*(.*)$/.exec(String(raw).split('\n')[0] ?? '')?.[1]?.trim() ?? ''
  const content = String(raw)
    .split('\n')
    .slice(1)                          // drop the [!TYPE] line
    .map(l => l.replace(/^>\s?/, ''))  // strip "> " prefix
    .join('\n')
    .trim()
  return { type: (match?.[1] ?? 'NOTE').toUpperCase(), content, ...(title ? { title } : {}) }
}

/** Le callout sans son cadre : le titre (s'il y en a un), puis le corps. */
function unwrapCallout(d: CalloutData): string {
  return [d.title, d.content].filter(Boolean).join('\n\n')
}

/** Change le type, en gardant le reste de la ligne de titre et le corps. */
function withType(raw: string, type: string): string {
  return raw.replace(/^(>\s*\[!)\w+(\])/, `$1${type}$2`)
}

/** Change le corps, en gardant la ligne de titre. */
function withContent(raw: string, content: string): string {
  const first = raw.split('\n')[0]
  const body = content.split('\n').map(l => (l ? `> ${l}` : '>'))
  return [first, ...body].join('\n')
}

/**
 * Le corps du callout, rendu comme la note (gras, listes, tableaux...) quand
 * l'editeur sait le faire. Sinon, le texte tel quel.
 */
function fillBody(body: HTMLElement, content: string, ctx?: BlockContext): void {
  let rich: HTMLElement | null = null
  if (content && ctx?.renderMarkdown) {
    try { rich = ctx.renderMarkdown(content) } catch { rich = null }
  }
  if (rich) {
    body.style.whiteSpace = 'normal'
    body.replaceChildren(rich)
  } else {
    body.style.whiteSpace = 'pre-wrap'
    body.textContent = content
  }
}

function renderCallout(d: CalloutData, ctx?: BlockContext): HTMLElement {
  const style = COLORS[d.type] ?? DEFAULT

  const el = document.createElement('div')
  el.className = `callout callout-${d.type.toLowerCase()}`
  el.style.cssText = `border-left:4px solid ${style.border};background:${style.bg};border-radius:4px;padding:8px 12px;margin:4px 0`

  const title = document.createElement('div')
  title.className = 'callout-title'
  title.style.cssText = `font-weight:600;color:${style.border};margin-bottom:4px;display:flex;align-items:center;gap:6px`
  title.append(createIcon(iconApi, style.icon, { size: 16 }), d.type.charAt(0) + d.type.slice(1).toLowerCase())

  const body = document.createElement('div')
  body.className = 'callout-body'
  body.style.cssText = 'color:inherit;white-space:pre-wrap'
  fillBody(body, d.content, ctx)

  el.appendChild(title)
  el.appendChild(body)
  return el
}

/** Le corps du callout en zone de texte, le temps de l'ecrire. */
function editBody(el: HTMLElement, body: HTMLElement, ctx: BlockEditContext): void {
  const area = document.createElement('textarea')
  area.className = 'callout-editor'
  area.dataset.testid = 'callout-editor'
  area.value = deserializeCallout(ctx.source()).content
  area.style.cssText = 'width:100%;box-sizing:border-box;resize:none;overflow:hidden;font:inherit;color:inherit;background:transparent;border:1px dashed currentColor;border-radius:4px;padding:2px 4px;opacity:0.95'
  const fit = () => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight + 2}px` }
  body.style.whiteSpace = 'pre-wrap'
  body.replaceChildren(area)
  body.style.opacity = ''
  // Garde l'element pendant l'ecriture (voir BlockEditContext).
  el.dataset.plumeEditing = '1'
  area.focus()
  area.setSelectionRange(area.value.length, area.value.length)
  requestAnimationFrame(fit)
  let timer: ReturnType<typeof setTimeout> | null = null
  const commit = () => {
    if (timer) { clearTimeout(timer); timer = null }
    ctx.replace(withContent(ctx.source(), area.value.replace(/\s+$/, '')))
  }
  area.addEventListener('input', () => {
    fit()
    if (timer) clearTimeout(timer)
    timer = setTimeout(commit, 500)
  })
  area.addEventListener('keydown', e => {
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); area.blur() }
  })
  area.addEventListener('blur', () => {
    commit()
    delete el.dataset.plumeEditing
    // Le rendu reprend.
    const content = deserializeCallout(ctx.source()).content
    fillBody(body, content || 'Écrire…', content ? ctx : undefined)
    body.style.opacity = content ? '' : '0.6'
  })
}

let iconApi: PluginAPI['icons'] | undefined

// plugin-callout: renders > [!NOTE] callout blocks.
const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-callout',
    scope: 'personal',
    name: 'Callout Blocks',
    version: '0.0.1',
    permissions: ['ui:editor'],
    defaultActive: true,
  },

  async onload(api: PluginAPI) {
    iconApi = api.icons
    api.triggers.register({ id: 'callout', character: '> [!', description: 'Callout block (> [!TYPE])' })

    api.blocks.register({
      type: 'callout',
      trigger: [
        { id: 'callout-note',     label: 'Callout Note',     description: '> [!NOTE] bloc info',         icon: 'pencil', category: 'Callouts', insert: '> [!NOTE]\n> '     },
        { id: 'callout-info',     label: 'Callout Info',     description: '> [!INFO] information',       icon: 'info', category: 'Callouts', insert: '> [!INFO]\n> '     },
        { id: 'callout-tip',      label: 'Callout Tip',      description: '> [!TIP] conseil',            icon: 'flame', category: 'Callouts', insert: '> [!TIP]\n> '      },
        { id: 'callout-success',  label: 'Callout Success',  description: '> [!SUCCESS] succès',         icon: 'check', category: 'Callouts', insert: '> [!SUCCESS]\n> '  },
        { id: 'callout-warning',  label: 'Callout Warning',  description: '> [!WARNING] avertissement',  icon: 'triangle-alert', category: 'Callouts', insert: '> [!WARNING]\n> '  },
        { id: 'callout-caution',  label: 'Callout Caution',  description: '> [!CAUTION] attention',      icon: 'triangle-alert', category: 'Callouts', insert: '> [!CAUTION]\n> '  },
        { id: 'callout-danger',   label: 'Callout Danger',   description: '> [!DANGER] danger',          icon: 'zap', category: 'Callouts', insert: '> [!DANGER]\n> '   },
        { id: 'callout-bug',      label: 'Callout Bug',      description: '> [!BUG] bug',                icon: 'bug', category: 'Callouts', insert: '> [!BUG]\n> '      },
        { id: 'callout-todo',     label: 'Callout Todo',     description: '> [!TODO] à faire',           icon: 'circle-check', category: 'Callouts', insert: '> [!TODO]\n> '     },
        { id: 'callout-question', label: 'Callout Question', description: '> [!QUESTION] question',      icon: 'circle-help', category: 'Callouts', insert: '> [!QUESTION]\n> ' },
      ],
      detect: /^>\s*\[!\w+\]/,
      serialize: (data) => serializeCallout(data as CalloutData),
      deserialize: (raw) => deserializeCallout(String(raw)),
      createEditorWidget: (_data, _ctx) => ({
        mount: (_el) => {},
        destroy: () => {},
      }),
      renderClient: (data, ctx) => renderCallout(data as CalloutData, ctx),

      // Mode classique : le type se choisit dans le titre, le corps s'ecrit
      // sur place. La syntaxe > [!TYPE] n'apparait pas.
      renderEditable: (data, ctx) => {
        const d = data as CalloutData
        const el = renderCallout(d, ctx)
        const title = el.querySelector('.callout-title') as HTMLElement
        const body = el.querySelector('.callout-body') as HTMLElement
        const select = document.createElement('select')
        select.className = 'callout-type'
        select.dataset.testid = 'callout-type'
        select.title = 'Type du callout'
        select.style.cssText = `font:inherit;font-weight:600;color:inherit;background:transparent;border:0;padding:0;cursor:pointer;appearance:auto`
        for (const type of Object.keys(COLORS)) {
          const o = document.createElement('option')
          o.value = type
          o.textContent = LABELS[type] ?? type
          o.selected = type === d.type
          select.appendChild(o)
        }
        if (!COLORS[d.type]) {
          const o = document.createElement('option')
          o.value = d.type
          o.textContent = d.type
          o.selected = true
          select.appendChild(o)
        }
        // Sans le focus, l'objet se redessine aux couleurs du nouveau type.
        select.addEventListener('change', () => { select.blur(); ctx.replace(withType(ctx.source(), select.value)) })
        select.addEventListener('mousedown', e => e.stopPropagation())
        title.lastChild?.remove()
        title.appendChild(select)

        body.style.cursor = 'text'
        if (!d.content) {
          body.textContent = 'Écrire…'
          body.style.opacity = '0.6'
        }
        body.addEventListener('mousedown', e => {
          // Le clic droit garde le menu du bloc.
          if (e.button !== 0 || body.querySelector('textarea')) return
          // Un lien ou une case du rendu garde son clic.
          if ((e.target as Element | null)?.closest?.('a, input, button')) return
          e.preventDefault()
          editBody(el, body, ctx)
        })
        return el
      },

      // Clic droit « Retirer le callout » : son titre et son corps restent
      // dans la note, sans le cadre ni les >.
      unwrap: { label: 'Retirer le callout', content: (data) => unwrapCallout(data as CalloutData) },

      menu: (data, ctx) => {
        const d = data as CalloutData
        return Object.keys(COLORS).map(type => ({
          id: `callout-type-${type.toLowerCase()}`,
          label: LABELS[type] ?? type,
          checked: type === d.type,
          run: () => ctx.replace(withType(ctx.source(), type)),
        }))
      },
    })
  },

  async onunload() {},
}

export default plugin
