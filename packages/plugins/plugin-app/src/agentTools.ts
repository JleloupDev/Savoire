// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils d'agent des applications (ADR-033) : apprendre a les ecrire
// (app_guide), les lister, les creer, les lire, ecrire un fichier de leur
// dossier. Dans l'appli ET sur le pair indexeur (runtime 'server') : ChatGPT
// et Claude s'en servent par le MCP du serveur. Les fichiers sont des textes
// partages ; changer un fichier existant passe par changeNoteText : fait
// directement, ou propose dans la Revision, selon les droits de l'agent.
import { changeNoteText, type PluginAPI, type PluginTool, type ToolParamSchema } from '@savoire/plugin-api'
import { APP_GUIDE } from './guide'
import { appFolderOf, normalizeAppPath, relPathOf, vaultPathOf } from './paths'

const RUNTIMES = ['app', 'server'] as const
/** Un fichier ecrit par un agent, au plus (caracteres). */
const MAX_FILE = 2_000_000
/** Fichiers donnes a app_create, au plus. */
const MAX_FILES = 50

type Args = Record<string, unknown>

/** « Dossier/Nom.app », « Dossier/Nom » ou « Dossier » (-> Dossier/Dossier.app). */
export function appPathOf(raw: unknown): string {
  const p = typeof raw === 'string' ? raw.trim().replace(/^\/+|\/+$/g, '') : ''
  if (!p) throw new Error('Donnez le chemin de l’application (ex. « Histoire/Histoire.app »).')
  if (p.split('/').some(s => s === '..' || s === '.')) throw new Error('Chemin invalide.')
  if (/\.app$/i.test(p)) return p
  const last = p.slice(p.lastIndexOf('/') + 1)
  return p.includes('/') ? `${p}.app` : `${p}/${last}.app`
}

function tree(api: PluginAPI) {
  return (api.vault.getFileTree?.() ?? []).filter(f => !f.path.startsWith('.trash/') && !api.vault.isTrashed?.(f.docId))
}

function findApp(api: PluginAPI, raw: unknown): { id: string; path: string } {
  const wanted = appPathOf(raw)
  const all = tree(api)
  const hit = all.find(f => f.path.toLowerCase() === wanted.toLowerCase())
    ?? all.find(f => /\.app$/i.test(f.path) && f.path.toLowerCase().endsWith(`/${wanted.slice(wanted.lastIndexOf('/') + 1).toLowerCase()}`))
  if (!hit) throw new Error(`Application introuvable : ${wanted}. Voir app_list.`)
  return { id: hit.docId, path: hit.path }
}

async function idAfterCreate(api: PluginAPI, path: string, timeoutMs = 5000): Promise<string> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const id = api.vault.resolveDocumentId(path) ?? tree(api).find(f => f.path === path)?.docId
    if (id) return id
    if (Date.now() > until) throw new Error(`Fichier introuvable après sa création : ${path}.`)
    await new Promise(res => setTimeout(res, 50))
  }
}

async function createTextFile(api: PluginAPI, path: string, content: string): Promise<string> {
  if (typeof api.vault.createFile !== 'function' || typeof api.vault.editText !== 'function') throw new Error('Ce vault ne permet pas de créer de fichier.')
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  if (dir) await api.vault.createFolder?.(dir)
  await api.vault.createFile(path)
  const id = await idAfterCreate(api, path)
  if (content) await api.vault.editText(id, () => content)
  return id
}

function checkContent(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new Error(`${what} : texte attendu.`)
  if (v.length > MAX_FILE) throw new Error(`${what} : trop long (${v.length} caractères, ${MAX_FILE} au plus).`)
  return v
}

const APP: ToolParamSchema = { type: 'string', description: 'L’application : son fichier .app (« Dossier/Nom.app »), ou son dossier.' }
const FILE: ToolParamSchema = { type: 'string', description: 'Un fichier du dossier de l’application, en chemin relatif (« main.js », « donnees/plans.json »).' }

export function appAgentTools(api: PluginAPI): PluginTool[] {
  return [
    {
      spec: {
        name: 'app_guide', title: 'Guide des applications', action: 'read', runtimes: [...RUNTIMES],
        description: 'Comment écrire une application Savoire (fichier .app) : fichiers, React fourni, objet savoire (fichiers du dossier, bases), workers, limites. '
          + 'À lire avant app_create ou app_write_file.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      async run() {
        return { text: APP_GUIDE }
      },
    },
    {
      spec: {
        name: 'app_list', title: 'Lister les applications', action: 'read', runtimes: [...RUNTIMES],
        description: 'Les applications du vault (fichiers .app), avec le nombre de fichiers de leur dossier.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      async run() {
        const all = tree(api)
        const apps = all.filter(f => /\.app$/i.test(f.path)).sort((a, b) => a.path.localeCompare(b.path))
        if (!apps.length) return { text: 'Aucune application dans ce vault. Pour en créer une : app_guide puis app_create.' }
        const lines = apps.slice(0, 200).map(a => {
          const folder = appFolderOf(a.path)
          const n = all.filter(f => f.path !== a.path && relPathOf(folder, f.path) !== null).length
          return `- ${a.path} (${folder ? `${n} fichier(s) dans « ${folder} »` : 'à la racine : lecture seule'})`
        })
        return { text: `${apps.length} application(s) :\n${lines.join('\n')}`, sources: apps.slice(0, 20).map(a => ({ docId: a.docId, path: a.path })) }
      },
    },
    {
      spec: {
        name: 'app_create', title: 'Créer une application', action: 'create', runtimes: [...RUNTIMES],
        description: 'Crée une application : son dossier, son fichier .app (le HTML de la page) et, au besoin, d’autres fichiers '
          + '(modules .js, styles .css, données .json). Lisez app_guide d’abord. Une application se crée toujours ainsi, jamais par une note.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Le dossier de l’application, ou son fichier .app (« Histoire/Histoire.app »). Jamais à la racine du vault.' },
            html: { type: 'string', description: 'Le contenu du .app : le HTML de la page (sans <html> ni <body>), avec ses <script type="module">.' },
            files: { type: 'object', description: 'Autres fichiers : { "main.js": "…", "donnees/plans.json": "…" } (chemins relatifs au dossier, 50 au plus).' },
          },
          required: ['path', 'html'], additionalProperties: false,
        },
      },
      async run(args, ctx) {
        if (ctx.mode === 'propose') throw new Error('En mode proposition, un agent ne crée pas d’application : il faut le droit de créer en direct.')
        const path = appPathOf(args.path)
        const folder = appFolderOf(path)
        if (!folder) throw new Error('Une application se range dans un dossier, jamais à la racine du vault.')
        if (tree(api).some(f => f.path.toLowerCase() === path.toLowerCase())) throw new Error(`Un document existe déjà : ${path}. Pour le changer : app_write_file.`)
        const html = checkContent(args.html, 'html')
        const files: [string, string][] = []
        if (args.files !== undefined) {
          if (!args.files || typeof args.files !== 'object' || Array.isArray(args.files)) throw new Error('files : objet { chemin: texte } attendu.')
          const entries = Object.entries(args.files as Args)
          if (entries.length > MAX_FILES) throw new Error(`Trop de fichiers (${MAX_FILES} au plus) : ajoutez les autres avec app_write_file.`)
          for (const [rel, text] of entries) files.push([normalizeAppPath(rel), checkContent(text, rel)])
        }
        const id = await createTextFile(api, path, html)
        const done: string[] = []
        for (const [rel, text] of files) {
          const full = vaultPathOf(folder, rel)
          if (tree(api).some(f => f.path === full)) continue
          await createTextFile(api, full, text)
          done.push(rel)
        }
        return {
          text: `Application créée : ${path}${done.length ? `, avec ${done.length} fichier(s) : ${done.join(', ')}` : ''}. Elle s’ouvre dans Savoire comme une note.`,
          sources: [{ docId: id, path }],
        }
      },
    },
    {
      spec: {
        name: 'app_read', title: 'Lire une application', action: 'read', runtimes: [...RUNTIMES],
        description: 'Les fichiers du dossier d’une application, et le texte du .app ou d’un de ses fichiers (file).',
        inputSchema: { type: 'object', properties: { app: APP, file: FILE }, required: ['app'], additionalProperties: false },
      },
      async run(args) {
        const app = findApp(api, args.app)
        const folder = appFolderOf(app.path)
        const all = tree(api)
        const rels = all.map(f => relPathOf(folder, f.path)).filter((r): r is string => r !== null).sort()
        let target = app
        if (args.file !== undefined) {
          const rel = normalizeAppPath(args.file)
          const full = vaultPathOf(folder, rel)
          const hit = all.find(f => f.path === full)
          if (!hit) throw new Error(`Fichier introuvable dans l’application : ${rel}.`)
          target = { id: hit.docId, path: hit.path }
        }
        const text = await api.vault.read(target.id).catch(() => '(fichier binaire : non lisible ici)')
        return {
          text: `Application ${app.path}\nFichiers (${rels.length}) :\n${rels.slice(0, 300).map(r => `- ${r}`).join('\n')}\n\n— ${target.path} —\n${text || '(vide)'}`,
          sources: [{ docId: target.id, path: target.path }],
        }
      },
    },
    {
      spec: {
        name: 'app_write_file', title: 'Écrire un fichier d’application', action: 'edit', runtimes: [...RUNTIMES],
        description: 'Crée ou remplace un fichier du dossier d’une application (module .js, style .css, données .json, ou le .app lui-même avec file = son nom). '
          + 'Remplacer un passage exact : find + replace ; sinon content remplace tout le texte.',
        inputSchema: {
          type: 'object',
          properties: {
            app: APP, file: FILE,
            content: { type: 'string', description: 'Le texte complet du fichier.' },
            find: { type: 'string', description: 'Ou : un passage exact à remplacer (une seule occurrence).' },
            replace: { type: 'string', description: 'Le texte qui remplace find.' },
          },
          required: ['app', 'file'], additionalProperties: false,
        },
      },
      async run(args, ctx) {
        const app = findApp(api, args.app)
        const folder = appFolderOf(app.path)
        if (!folder) throw new Error('Cette application est à la racine du vault : rangez-la dans un dossier.')
        const rel = normalizeAppPath(args.file)
        const full = vaultPathOf(folder, rel)
        const find = typeof args.find === 'string' ? args.find : undefined
        const content = args.content !== undefined ? checkContent(args.content, 'content') : undefined
        if (content === undefined && find === undefined) throw new Error('Donnez content (tout le texte) ou find + replace.')
        const hit = tree(api).find(f => f.path === full)
        if (!hit) {
          if (content === undefined) throw new Error(`Fichier introuvable : ${rel}. Pour le créer, donnez content.`)
          if (ctx.mode === 'propose') throw new Error('En mode proposition, un agent ne crée pas de fichier : il faut le droit de créer en direct.')
          const id = await createTextFile(api, full, content)
          return { text: `Fichier créé : ${full}.`, sources: [{ docId: id, path: full }] }
        }
        const replace = typeof args.replace === 'string' ? args.replace : ''
        const r = await changeNoteText(api, ctx, hit.docId, current => {
          if (content !== undefined) return content
          const at = current.indexOf(find!)
          if (at < 0) throw new Error('Passage introuvable (find) : relisez le fichier avec app_read.')
          if (current.indexOf(find!, at + 1) >= 0) throw new Error('Passage trouvé plusieurs fois (find) : donnez un passage plus long.')
          return current.slice(0, at) + replace + current.slice(at + find!.length)
        }, `fichier ${rel} de l’application`)
        const said = r === 'proposed' ? 'Modification proposée dans la Révision' : r === 'unchanged' ? 'Rien n’a changé' : 'Fichier modifié'
        return { text: `${said} : ${full}.`, sources: [{ docId: hit.docId, path: full }] }
      },
    },
  ]
}
