// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultPlugin, PluginAPI } from '@savoire/plugin-api'

// ── Helpers ───────────────────────────────────────────────────────────────

function parseFrontmatter(source: string): { meta: Record<string, string>; body: string } {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: source }
  const meta: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx > 0) {
      meta[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim()
    }
  }
  return { meta, body: match[2] }
}

// ── Module chrome styles ──────────────────────────────────────────────────

const CHROME = {
  container: [
    'border:1px solid var(--border,#3d3d5c)',
    'border-radius:8px',
    'margin:6px 0',
    'background:var(--bg-elevated,#1e1e2e)',
    'overflow:hidden',
  ].join(';'),

  header: [
    'display:flex',
    'align-items:center',
    'gap:6px',
    'padding:5px 10px',
    'background:var(--bg-surface,#252535)',
    'border-bottom:1px solid var(--border,#3d3d5c)',
    'font-size:11px',
    'color:var(--text-muted,#aaa)',
    'user-select:none',
  ].join(';'),

  modeBtn: (active: boolean) => [
    'padding:2px 8px',
    'border-radius:4px',
    'border:none',
    'cursor:pointer',
    'font-size:10px',
    'font-family:inherit',
    'font-weight:600',
    'letter-spacing:0.04em',
    active
      ? 'background:var(--accent,#8b5cf6);color:#fff'
      : 'background:transparent;color:var(--text-faint,#666)',
  ].join(';'),

  content: [
    'padding:10px 14px',
    'font-size:13px',
    'line-height:1.6',
    'color:var(--text,#ddd)',
  ].join(';'),

  applyBtn: [
    'margin-top:8px',
    'padding:3px 12px',
    'background:var(--accent,#8b5cf6)',
    'color:#fff',
    'border:none',
    'border-radius:4px',
    'cursor:pointer',
    'font-size:11px',
    'font-family:inherit',
  ].join(';'),
}

const MODULE_THEME_DEFAULTS: Readonly<Record<string, string>> = {
  '--bg-surface': '#252535',
  '--bg-elevated': '#1e1e2e',
  '--border': '#3d3d5c',
  '--text': '#ddd',
  '--text-muted': '#aaa',
  '--text-faint': '#666',
  '--accent': '#8b5cf6',
}

function applyMissingThemeVars(el: HTMLElement) {
  const root = getComputedStyle(document.documentElement)
  for (const [name, fallback] of Object.entries(MODULE_THEME_DEFAULTS)) {
    const current = root.getPropertyValue(name).trim()
    if (!current) el.style.setProperty(name, fallback)
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────

type ModuleMode = 'module' | 'source'
const MODULE_HEIGHT_STORAGE_KEY = 'module:manual-height'
const MIN_IFRAME_HEIGHT = 180
const MAX_IFRAME_HEIGHT = 1400

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-module',
    name: 'Modules',
    version: '1.0.0',
    permissions: ['ui:editor', 'vault:read', 'vault:write'],
    defaultActive: true,
  },

  async onload(api: PluginAPI) {
    api.triggers.register({ id: 'module', character: '@[[', description: 'Module embed editable' })

    api.blocks.register({
      type: 'module',
      trigger: {
        id: 'module-embed',
        label: 'Module',
        description: 'Integrer un module editable @[[...]]',
        icon: 'box',
        category: 'Embeds',
        insert: '@[[chemin/fichier.md]]',
      },

      detect: /@\[\[(.+?)\]\]/,

      deserialize(raw) {
        const match = String(raw).match(/@\[\[(.+?)\]\]/)
        return { path: match?.[1] ?? '' }
      },

      serialize(data) {
        return `@[[${(data as { path: string }).path}]]`
      },

      createEditorWidget: (_data, _ctx) => ({
        mount: (_el) => {},
        destroy: () => {},
      }),

      renderClient(data, _ctx) {
        const { path: rawPath } = data as { path: string }
        const path = rawPath.trim()

        let currentMode: ModuleMode = 'module'
        let currentIframe: HTMLIFrameElement | null = null
        let iframeCleanup: (() => void) | null = null
        let manualHeight: number | null = null

        function loadManualHeight(): number | null {
          try {
            const raw = localStorage.getItem(`${MODULE_HEIGHT_STORAGE_KEY}:${path}`)
            if (!raw) return null
            const n = Number.parseInt(raw, 10)
            if (Number.isNaN(n)) return null
            return Math.max(MIN_IFRAME_HEIGHT, Math.min(MAX_IFRAME_HEIGHT, n))
          } catch {
            return null
          }
        }

        function saveManualHeight(height: number | null) {
          try {
            const key = `${MODULE_HEIGHT_STORAGE_KEY}:${path}`
            if (height === null) localStorage.removeItem(key)
            else localStorage.setItem(key, String(height))
          } catch {
            // ignore storage errors
          }
        }

        const container = document.createElement('div')
        applyMissingThemeVars(container)
        container.style.cssText = CHROME.container

        const header = document.createElement('div')
        header.style.cssText = CHROME.header

        const icon = document.createElement('span')
        icon.textContent = 'Module'

        const label = document.createElement('span')
        label.textContent = path
        label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'

        const btnModule = document.createElement('button')
        const btnSource = document.createElement('button')
        const btnAuto = document.createElement('button')
        btnModule.textContent = 'Module'
        btnSource.textContent = 'Source'
        btnAuto.textContent = 'Auto'

        header.append(icon, label, btnAuto, btnModule, btnSource)
        container.appendChild(header)

        const content = document.createElement('div')
        content.style.cssText = CHROME.content
        container.appendChild(content)

        container.addEventListener('mousedown', e => e.stopPropagation())
        container.addEventListener('click', e => e.stopPropagation())

        function updateButtons() {
          btnModule.style.cssText = CHROME.modeBtn(currentMode === 'module')
          btnSource.style.cssText = CHROME.modeBtn(currentMode === 'source')
          btnAuto.style.cssText = CHROME.modeBtn(manualHeight === null)
          btnAuto.title = manualHeight === null ? 'Hauteur auto' : 'Revenir en hauteur auto'
        }

        function destroyIframe() {
          iframeCleanup?.()
          iframeCleanup = null
          currentIframe?.remove()
          currentIframe = null
        }

        function buildIframe() {
          destroyIframe()
          manualHeight = loadManualHeight()
          updateButtons()

          const vaultId = api.vault.getVaultId?.() ?? ''
          const docId   = api.vault.resolveDocumentId(path) ?? ''
          const token   = api.vault.getToken?.() ?? ''
          const iframe  = document.createElement('iframe')
          console.log(`[plugin-module] buildIframe path="${path}" vaultId="${vaultId}" docId="${docId}" hasToken=${!!token}`)
          // Bootstrap is async: create an ephemeral grant then point iframe to /view?grant=...
          iframe.src = 'about:blank'
          iframe.style.cssText = [
            'width:100%', 'border:none', 'display:block',
            'overflow:hidden', `height:${manualHeight ?? 260}px`,
          ].join(';')
          iframe.scrolling = 'no'
          currentIframe = iframe

          void (async () => {
            async function refreshAccessTokenFromSession(): Promise<string | null> {
              try {
                const raw = sessionStorage.getItem('vault_accounts')
                if (!raw) return null
                const accounts = JSON.parse(raw) as Array<{ userId: string; refreshToken: string; isActive: boolean }>
                const active = accounts.find(a => a.isActive)
                if (!active?.refreshToken) return null

                const res = await fetch('/api/v1/auth/refresh', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ refreshToken: active.refreshToken }),
                })
                if (!res.ok) return null
                const dto = await res.json() as { accessToken: string; refreshToken: string }
                const updated = accounts.map(a =>
                  a.userId === active.userId ? { ...a, refreshToken: dto.refreshToken } : a,
                )
                sessionStorage.setItem('vault_accounts', JSON.stringify(updated))
                return dto.accessToken
              } catch {
                return null
              }
            }

            const shareTokenFromUrl = (() => {
              const match = window.location.pathname.match(/^\/share\/([^/?#]+)/)
              return match?.[1] ? decodeURIComponent(match[1]) : ''
            })()

            if (shareTokenFromUrl) {
              const shareParams = new URLSearchParams({ embed: '1', path })
              iframe.src = `/share/${encodeURIComponent(shareTokenFromUrl)}?${shareParams.toString()}`
              return
            }

            async function requestGrant(permission: 'read' | 'write', bearer: string) {
              const res = await fetch('/api/v1/view/internal-grants', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
                },
                body: JSON.stringify({
                  vaultId: vaultId || null,
                  docId: docId || null,
                  path,
                  permission,
                }),
              })
              return res
            }

            try {
              let bearer = token
              let res = await requestGrant('write', bearer)
              if (res.status === 401) {
                const refreshed = await refreshAccessTokenFromSession()
                if (refreshed) {
                  bearer = refreshed
                  res = await requestGrant('write', bearer)
                }
              }
              if (res.status === 403) res = await requestGrant('read', bearer)
              if (!res.ok) throw new Error(`view grant failed (${res.status})`)
              const dto = await res.json() as { grantToken: string; permission: string }
              const params = new URLSearchParams({ grant: dto.grantToken })
              if (dto.permission !== 'write') params.set('readOnly', 'true')
              iframe.src = `/view?${params.toString()}`
            } catch (err) {
              console.error('[plugin-module] view grant error', err)
              iframe.src = 'about:blank'
              const message = document.createElement('div')
              message.style.cssText = 'padding:8px 0;font-size:12px;color:var(--color-danger,#dc2626)'
              message.textContent = 'Impossible de charger le module.'
              content.innerHTML = ''
              content.appendChild(message)
            }
          })()

          const onMsg = (ev: MessageEvent) => {
            const msg = ev.data as Record<string, unknown>
            if (!msg || typeof msg !== 'object') return
            if (typeof msg['type'] !== 'string') return
            const fromOurIframe = ev.source === iframe.contentWindow
            if (msg['type'] === 'module:resize' && currentIframe && fromOurIframe && manualHeight === null) {
              currentIframe.style.height = `${msg['height']}px`
            }
          }

          const handle = document.createElement('div')
          handle.style.cssText = [
            'height:10px',
            'cursor:ns-resize',
            'background:linear-gradient(90deg, transparent, var(--border,#3d3d5c), transparent)',
            'border-radius:0 0 6px 6px',
            'opacity:0.8',
            'margin-top:4px',
          ].join(';')
          handle.title = 'Redimensionner le module'

          let dragging = false
          let startY = 0
          let startHeight = 0
          const onMove = (ev: PointerEvent) => {
            if (!dragging || !currentIframe) return
            const delta = ev.clientY - startY
            const next = Math.max(MIN_IFRAME_HEIGHT, Math.min(MAX_IFRAME_HEIGHT, Math.round(startHeight + delta)))
            currentIframe.style.height = `${next}px`
            manualHeight = next
            saveManualHeight(next)
            updateButtons()
          }
          const onUp = () => { dragging = false }
          const onDown = (ev: PointerEvent) => {
            if (!currentIframe) return
            dragging = true
            startY = ev.clientY
            startHeight = currentIframe.getBoundingClientRect().height
            handle.setPointerCapture(ev.pointerId)
          }
          handle.addEventListener('pointerdown', onDown)
          window.addEventListener('pointermove', onMove)
          window.addEventListener('pointerup', onUp)

          window.addEventListener('message', onMsg)
          iframeCleanup = () => {
            window.removeEventListener('message', onMsg)
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
            handle.removeEventListener('pointerdown', onDown)
          }

          const wrap = document.createElement('div')
          wrap.appendChild(iframe)
          wrap.appendChild(handle)
          return wrap
        }

        function showMode(mode: ModuleMode) {
          currentMode = mode
          updateButtons()
          content.innerHTML = ''

          if (mode === 'module') {
            const el = buildIframe()
            content.appendChild(el)
          } else {
            destroyIframe()
            content.textContent = '(source view not available in standalone iframe mode)'
          }
        }

        btnModule.addEventListener('click', () => showMode('module'))
        btnSource.addEventListener('click', () => showMode('source'))
        btnAuto.addEventListener('click', () => {
          manualHeight = null
          saveManualHeight(null)
          updateButtons()
          if (currentIframe) currentIframe.style.height = '260px'
        })

        // see ADR-009
        updateButtons()
        content.textContent = 'Loading...'
        setTimeout(() => {
          if (!container.isConnected) return
          showMode('module')
        }, 0)

        return container
      },
    })

    api.hooks.beforeParse((source: string) => {
      const { meta, body } = parseFrontmatter(source)
      if (meta['type'] !== 'module') return source
      const banner =
        `<div style="background:var(--accent-dim,rgba(139,92,246,0.12));` +
        `border-left:3px solid var(--accent,#8b5cf6);padding:4px 10px;` +
        `border-radius:0 4px 4px 0;font-size:11px;color:var(--accent,#8b5cf6);` +
        `margin-bottom:10px">Module document</div>\n\n`
      return banner + body
    })

    api.commands.register({
      id: 'module:create',
      label: 'Create Module',
      run: () => { console.log('[plugin-module] module:create') },
    })
  },

  async onunload() {},
}

export default plugin
