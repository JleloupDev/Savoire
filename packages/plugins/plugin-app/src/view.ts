// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Vue d'un fichier .app : l'application (plein cadre, plein ecran a la
// demande) ou son code (texte partage, edite a plusieurs). Les workers qui
// tournent se voient dans la barre, avec un bouton pour les arreter.
import type { FileContext, FileView, PluginAPI } from '@savoire/plugin-api'
import { confirmIn } from '@savoire/plugin-board'
import { createCodeEditor, readContent, type CodeEditor } from './editor'
import { AppHost } from './host'
import { loadAppLibraries } from './libs'
import { appFolderOf, isCodeFile } from './paths'
import { ensureAppStyle } from './style'
import { APP_TEMPLATE } from './template'

type Mode = 'app' | 'code'

/** Releve des fichiers de code du dossier : on signale qu'ils ont change. */
const CODE_POLL_MS = 2000

export function createAppView(path: string, ctx: FileContext, api: PluginAPI | undefined): FileView {
  ensureAppStyle()
  let readOnly = !!ctx.readOnly || !ctx.text
  let host: AppHost | null = null
  let editor: CodeEditor | null = null
  let mode: Mode = 'app'
  let source = ''
  let loadedSource: string | null = null
  let codeVersions = ''
  let poll: ReturnType<typeof setInterval> | null = null
  let workers = 0
  let status: HTMLElement
  let preview: HTMLElement
  let codePane: HTMLElement
  let example: HTMLButtonElement
  let workersBox: HTMLElement
  let workersText: HTMLElement
  let root: HTMLElement
  const buttons = new Map<Mode, HTMLButtonElement>()
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.app$/i, '')
  const folder = appFolderOf(path)

  const setStatus = (msg: string, bad = false) => {
    status.textContent = msg
    status.classList.toggle('board-status-bad', bad)
  }
  const versionsOfCode = (): string => {
    const prefix = folder ? `${folder}/` : ''
    return (api?.vault.getFileTree?.() ?? [])
      .filter(f => f.path.startsWith(prefix) && !f.path.startsWith('.trash/') && isCodeFile(f.path))
      .map(f => `${f.path}:${JSON.stringify(f.crdtVersion ?? null)}`).sort().join('|')
  }
  const showWorkers = (n: number) => {
    if (n > 0 && workers === 0) api?.workspace.notify?.('info', 'Un worker tourne', `Dans l'application « ${name} ».`)
    workers = n
    workersBox.hidden = n === 0
    workersText.innerHTML = ''
    const b = document.createElement('b')
    b.textContent = String(n)
    workersText.append(b, n > 1 ? ' workers en cours' : ' worker en cours')
  }
  const launch = () => {
    host?.dispose()
    showWorkers(0)
    setStatus('')
    if (!source.trim()) {
      preview.replaceChildren()
      setStatus('Application vide : écrivez son code (onglet Code) ou insérez l\'exemple.')
      return
    }
    const h = new AppHost(api, {
      appPath: path,
      readOnly,
      onError: msg => setStatus(`⚠ ${msg}`, true),
      confirmWrite: what => confirmIn(preview, what),
      onWorkers: showWorkers,
    })
    host = h
    preview.replaceChildren(h.frame)
    loadedSource = source
    codeVersions = versionsOfCode()
    void loadAppLibraries()
      .then(libs => h.loadApp(source, libs))
      .catch(err => setStatus(`⚠ ${err instanceof Error ? err.message : String(err)}`, true))
  }
  const setMode = (m: Mode) => {
    mode = m
    codePane.hidden = m !== 'code'
    preview.hidden = m !== 'app'
    for (const [k, b] of buttons) b.classList.toggle('board-btn-on', k === m)
    // Le code a change pendant qu'on l'ecrivait : l'application repart.
    if (m === 'app' && loadedSource !== source) launch()
  }

  return {
    mount(container: HTMLElement) {
      const btn = (label: string, m: Mode) => {
        const b = document.createElement('button')
        b.type = 'button'; b.className = 'board-btn'; b.textContent = label; b.dataset.testid = `app-mode-${m}`
        b.addEventListener('click', () => setMode(m))
        buttons.set(m, b)
        return b
      }
      const action = (label: string, testid: string, run: () => void) => {
        const b = document.createElement('button')
        b.type = 'button'; b.className = 'board-btn'; b.textContent = label; b.dataset.testid = testid
        b.addEventListener('click', run)
        return b
      }
      const toolbar = document.createElement('div')
      toolbar.className = 'board-toolbar'
      const again = action('↻ Relancer', 'app-reload', launch)
      const full = action('Plein écran', 'app-fullscreen', () => {
        if (document.fullscreenElement) void document.exitFullscreen()
        else void root.requestFullscreen?.().catch(() => setStatus('Plein écran refusé par le navigateur.', true))
      })
      example = action('Insérer l\'exemple', 'app-example', () => {
        if (!editor || readOnly || editor.view.state.doc.length > 0) return
        editor.view.dispatch({ changes: { from: 0, insert: APP_TEMPLATE } })
        setMode('app')
      })
      example.hidden = true
      workersBox = document.createElement('span')
      workersBox.className = 'app-workers'
      workersBox.dataset.testid = 'app-workers'
      workersBox.hidden = true
      workersText = document.createElement('span')
      const stop = action('Arrêter', 'app-workers-stop', () => host?.stopWorkers())
      workersBox.append('⚙', workersText, stop)
      status = document.createElement('span')
      status.className = 'board-status'; status.dataset.testid = 'app-status'
      const spacer = document.createElement('span')
      spacer.className = 'board-spacer'
      toolbar.append(btn('Application', 'app'), btn('Code', 'code'), again, full, example, spacer, workersBox, status)
      codePane = document.createElement('div')
      codePane.className = 'board-code'
      preview = document.createElement('div')
      preview.className = 'board-preview'
      const panes = document.createElement('div')
      panes.className = 'board-panes'
      panes.append(codePane, preview)
      root = document.createElement('div')
      root.className = 'board-view app-view'; root.dataset.testid = 'app-view'
      root.append(toolbar, panes)
      container.replaceChildren(root)

      const start = (doc: string) => {
        source = doc
        editor = createCodeEditor({
          parent: codePane, doc, text: ctx.text, readOnly, language: 'html',
          onChange: next => {
            source = next
            example.hidden = readOnly || next.length > 0
            if (mode === 'app' && loadedSource !== null && next !== loadedSource) setStatus('Le code de l\'application a changé : ↻ Relancer pour le prendre.')
          },
        })
        example.hidden = readOnly || doc.length > 0
        setMode(doc.trim() ? 'app' : 'code')
        if (!doc.trim()) launch()
        // Un module ou un style du dossier a change (une IA, un autre membre) :
        // on le signale, sans relancer en pleine utilisation.
        poll = setInterval(() => {
          if (!host || loadedSource === null) return
          const v = versionsOfCode()
          if (v !== codeVersions) { codeVersions = v; setStatus('Le code de l\'application a changé : ↻ Relancer pour le prendre.') }
        }, CODE_POLL_MS)
      }
      if (ctx.text) start(ctx.text.toString())
      else {
        setStatus('Lecture seule : cette application n\'est pas reliée à la synchronisation du vault.')
        void readContent(path, ctx).then(start, err => setStatus(`⚠ ${String(err)}`, true))
      }
    },
    setReadOnly(ro: boolean) {
      const next = ro || !ctx.text
      if (next === readOnly) return
      readOnly = next
      editor?.setReadOnly(next)
      launch()
    },
    destroy() {
      if (poll) clearInterval(poll)
      editor?.destroy()
      editor = null
      host?.dispose()
      host = null
    },
  }
}
