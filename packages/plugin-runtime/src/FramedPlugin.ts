// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Plugins tiers (Savoire Store) : leur code tourne dans une iframe ISOLEE,
// jamais dans la page de Savoire. Meme principe que les boards :
//
//  - sandbox="allow-scripts" sans allow-same-origin : origine opaque. Pas
//    d'acces a la page, a ses cookies, a son stockage, au jeton du compte ;
//  - Content-Security-Policy : aucun reseau, sauf si le plugin a le droit
//    `network:*` (alors https seulement) ;
//  - le plugin ne parle a Savoire que par messages, sur un canal tire au
//    sort, et seulement pour ce que ses droits (manifeste signe) permettent.
//
// Ce qu'un plugin tiers peut faire (objet `api` recu par onload) :
//
//   api.commands.register({ id, name, callback })      droit ui:editor
//   api.extractors.register({ id, label, extensions, version, extract })
//   api.vault.list(dir?) / api.vault.read(path)         droit vault:read
//   api.query(q)                                        droit vault:read
//   api.vault.write(path, text)                         droit vault:write
//   api.workspace.openFile(path)                        droit ui:editor
//   api.notify(message)
//
// Pas d'interface dans la page (vues, blocs) : elle demanderait d'executer
// le code du plugin dans la page. A venir : des vues dessinees dans une
// iframe du plugin.
import type { ExtractedContent, PluginAPI, PluginPermission } from '@savoire/plugin-api'

/** Taille max d'un message du plugin (caracteres JSON, approximatif). */
export const MAX_FRAME_MESSAGE = 8 * 1024 * 1024
/** Ecritures au plus, par minute et par plugin. */
export const MAX_FRAME_WRITES_PER_MINUTE = 60
/** Delai pour demarrer (onload), puis pour une commande ou une extraction. */
export const FRAME_START_TIMEOUT_MS = 10_000
export const FRAME_RUN_TIMEOUT_MS = 60_000

export function framedPluginCsp(network: boolean): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    network ? 'connect-src https:' : "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')
}

/** Le pont, dans l'iframe : il construit `api`, puis charge le plugin (CommonJS). */
function bridgeScript(channel: string): string {
  return `(()=>{const ch=${JSON.stringify(channel)};let n=0;const pend=new Map();const cmds=new Map(),exts=new Map();
const post=(m,tr)=>parent.postMessage(Object.assign({ch},m),'*',tr||[]);
const msg=e=>String(e&&e.message||e);
const call=(fn,args)=>new Promise((res,rej)=>{const id=++n;pend.set(id,[res,rej]);post({t:'call',id,fn,args})});
const str=(v,name)=>{if(typeof v!=='string'||!v)throw new Error(name+' attendu');return v};
const api=Object.freeze({
commands:Object.freeze({register(c){str(c&&c.id,'id');if(typeof c.callback!=='function')throw new Error('callback attendu');cmds.set(c.id,c.callback);return call('commands.register',[{id:c.id,name:String(c.name||c.id)}])}}),
extractors:Object.freeze({register(s){str(s&&s.id,'id');if(typeof s.extract!=='function')throw new Error('extract attendu');exts.set(s.id,s);return call('extractors.register',[{id:s.id,label:String(s.label||s.id),extensions:Array.isArray(s.extensions)?s.extensions.map(String):[],version:Number(s.version)||1}])}}),
vault:Object.freeze({list:d=>call('vault.list',[d==null?'':String(d)]),read:p=>call('vault.read',[String(p)]),write:(p,t)=>call('vault.write',[String(p),String(t)])}),
workspace:Object.freeze({openFile:p=>call('open',[String(p)])}),
query:q=>call('query',[q]),
notify:m=>call('notify',[String(m)])});
addEventListener('message',async e=>{if(e.source!==parent)return;const m=e.data;if(!m||m.ch!==ch)return;
if(m.t==='res'){const p=pend.get(m.id);if(p){pend.delete(m.id);m.ok?p[0](m.v):p[1](new Error(m.e))}return}
if(m.t==='run'){try{let v=true;if(m.kind==='command'){const f=cmds.get(m.key);if(!f)throw new Error('commande inconnue');await f()}
else if(m.kind==='extract'){const s=exts.get(m.key);if(!s)throw new Error('extracteur inconnu');v=await s.extract(m.bytes,m.info)}
post({t:'done',id:m.id,ok:true,v})}catch(err){post({t:'done',id:m.id,ok:false,e:msg(err)})}return}
if(m.t==='unload'){try{const p=module.exports&&(module.exports.default||module.exports);if(p&&typeof p.onunload==='function')await p.onunload()}catch(err){}post({t:'unloaded'})}});
window.module={exports:{}};window.exports=window.module.exports;
window.require=id=>{throw new Error('Bibliothèque indisponible dans le bac à sable : '+id+'. Embarquez-la dans main.js.')};
window.__savoireStart=async()=>{try{const p=module.exports&&(module.exports.default||module.exports);
if(!p||typeof p.onload!=='function')throw new Error('Le paquet doit exporter { onload(api), onunload() } (module.exports).');
await p.onload(api);post({t:'ready'})}catch(err){post({t:'failed',e:msg(err)})}};
addEventListener('error',e=>post({t:'error',m:String(e.message||e)}));
addEventListener('unhandledrejection',e=>post({t:'error',m:msg(e.reason)}));
})()`
}

/** `</script` dans le code fermerait la balise : on l'ecrit autrement (meme sens en JS). */
const escapeScript = (code: string): string => code.replace(/<\/(script)/gi, '<\\/$1')

export function buildPluginSrcdoc(code: string, opts: { channel: string; network: boolean }): string {
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${framedPluginCsp(opts.network)}">`
    + `<script>${bridgeScript(opts.channel)}</script>`
    + `<script>${escapeScript(code)}\n</script>`
    + `<script>__savoireStart()</script></head><body></body></html>`
}

/** Page cadre servie avec sa propre CSP (bureau), comme pour les boards. Null : srcdoc. */
let frameUrl: string | null = null
export function setPluginFrameUrl(url: string | null): void { frameUrl = url }
/** Messages de la page cadre (les memes que celle des boards). */
const FRAME_READY = 'savoire-board-ready'
const FRAME_BOOT = 'savoire-board-boot'

function randomChannel(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 500)

export interface FramedPluginOptions {
  /** Id de l'element du store. Les commandes et extracteurs sont prefixes par lui. */
  id: string
  name: string
  /** main.js du paquet (CommonJS). */
  code: string
  /** Droits du manifeste signe : ceux-la seulement. */
  permissions: readonly string[]
  /** L'API complete de Savoire : le plugin n'en voit que ce que ses droits permettent. */
  api: PluginAPI
  notify?: (message: string) => void
  onError?: (message: string) => void
  /** Ou poser l'iframe cachee. Defaut : document.body. */
  container?: HTMLElement
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

/** Un plugin tiers en cours d'execution, dans son iframe. */
export class FramedPlugin {
  readonly frame: HTMLIFrameElement
  private readonly channel = randomChannel()
  private readonly permissions: Set<string>
  private readonly onMessage = (e: MessageEvent) => this.handle(e)
  private readonly disposers: Array<() => void> = []
  private readonly runs = new Map<number, Pending>()
  private runSeq = 0
  private writes: number[] = []
  private started: { resolve: () => void; reject: (e: Error) => void } | null = null
  private pendingHtml: string | null = null
  private stopped = false

  constructor(private readonly opts: FramedPluginOptions) {
    this.permissions = new Set(opts.permissions)
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('referrerpolicy', 'no-referrer')
    frame.setAttribute('aria-hidden', 'true')
    frame.setAttribute('title', opts.name)
    frame.dataset.testid = 'framed-plugin'
    frame.dataset.pluginId = opts.id
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden'
    this.frame = frame
  }

  /** Charge le plugin ; resolu quand son onload est fini. */
  start(): Promise<void> {
    window.addEventListener('message', this.onMessage)
    const html = buildPluginSrcdoc(this.opts.code, {
      channel: this.channel,
      network: [...this.permissions].some(p => p.startsWith('network:')),
    })
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.opts.name} : démarrage trop long.`)), FRAME_START_TIMEOUT_MS)
      this.started = {
        resolve: () => { clearTimeout(timer); resolve() },
        reject: (e) => { clearTimeout(timer); reject(e) },
      }
    })
    if (frameUrl) { this.pendingHtml = html; this.frame.src = frameUrl }
    else this.frame.srcdoc = html
    ;(this.opts.container ?? document.body).appendChild(this.frame)
    return done.catch(err => { this.dispose(); throw err })
  }

  /** Arrete le plugin : son onunload, puis l'iframe et tout ce qu'il avait ajoute. */
  async stop(): Promise<void> {
    if (this.stopped) return
    const unloaded = new Promise<void>(resolve => {
      this.unloadedResolve = resolve
      setTimeout(resolve, 2000)
    })
    this.post({ t: 'unload' })
    await unloaded
    this.dispose()
  }

  private unloadedResolve: (() => void) | null = null

  private dispose(): void {
    if (this.stopped) return
    this.stopped = true
    window.removeEventListener('message', this.onMessage)
    for (const d of this.disposers.splice(0)) { try { d() } catch { /* deja retire */ } }
    for (const p of this.runs.values()) { clearTimeout(p.timer); p.reject(new Error(`${this.opts.name} est arrêté.`)) }
    this.runs.clear()
    this.frame.remove()
  }

  private post(msg: Record<string, unknown>, transfer?: Transferable[]): void {
    if (this.stopped) return
    // Origine opaque : '*' est la seule cible possible ; seule cette iframe le recoit.
    this.frame.contentWindow?.postMessage({ ch: this.channel, ...msg }, '*', transfer ?? [])
  }

  /** Demande au plugin d'executer un de ses rappels (commande, extraction). */
  private run(kind: 'command' | 'extract', key: string, extra: Record<string, unknown> = {}, transfer?: Transferable[]): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error(`${this.opts.name} est arrêté.`))
    const id = ++this.runSeq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.runs.delete(id); reject(new Error(`${this.opts.name} ne répond pas.`)) }, FRAME_RUN_TIMEOUT_MS)
      this.runs.set(id, { resolve, reject, timer })
      this.post({ t: 'run', id, kind, key, ...extra }, transfer)
    })
  }

  private handle(e: MessageEvent): void {
    if (this.stopped || e.source !== this.frame.contentWindow) return
    const m = e.data as Record<string, unknown> | null
    if (!m || typeof m !== 'object') return
    if (m.t === FRAME_READY && this.pendingHtml !== null) {
      const html = this.pendingHtml
      this.pendingHtml = null
      this.frame.contentWindow?.postMessage({ t: FRAME_BOOT, html }, '*')
      return
    }
    if (m.ch !== this.channel) return
    let size = 0
    try { size = JSON.stringify(m).length } catch { return }
    if (size > MAX_FRAME_MESSAGE) { this.opts.onError?.(`${this.opts.name} : message trop gros.`); return }
    switch (m.t) {
      case 'ready': this.started?.resolve(); this.started = null; return
      case 'failed': this.started?.reject(new Error(`${this.opts.name} : ${String(m.e)}`)); this.started = null; return
      case 'error': this.opts.onError?.(`${this.opts.name} : ${String(m.m ?? 'erreur')}`.slice(0, 500)); return
      case 'unloaded': this.unloadedResolve?.(); return
      case 'done': {
        const p = this.runs.get(Number(m.id))
        if (!p) return
        this.runs.delete(Number(m.id))
        clearTimeout(p.timer)
        if (m.ok) p.resolve(m.v)
        else p.reject(new Error(String(m.e ?? 'erreur')))
        return
      }
      case 'call': {
        const id = Number(m.id)
        void this.call(String(m.fn), Array.isArray(m.args) ? m.args : [])
          .then(v => this.post({ t: 'res', id, ok: true, v }))
          .catch(err => this.post({ t: 'res', id, ok: false, e: messageOf(err) }))
        return
      }
    }
  }

  private need(permission: PluginPermission): void {
    if (!this.permissions.has(permission)) throw new Error(`Droit « ${permission} » non demandé par le plugin.`)
  }

  private path(v: unknown): string {
    const p = String(v ?? '').replace(/^\/+/, '')
    if (!p || p.length > 1024 || p.split('/').some(s => s === '..')) throw new Error('Chemin invalide.')
    return p
  }

  private async call(fn: string, args: unknown[]): Promise<unknown> {
    const api = this.opts.api
    switch (fn) {
      case 'commands.register': {
        this.need('ui:editor')
        const spec = args[0] as { id?: unknown; name?: unknown }
        const id = `${this.opts.id}:${String(spec?.id ?? '').slice(0, 100)}`
        const label = `${this.opts.name} : ${String(spec?.name ?? spec?.id ?? '').slice(0, 100)}`
        const key = String(spec?.id)
        api.commands.register({
          id, label,
          run: () => { void this.run('command', key).catch(err => this.opts.onError?.(messageOf(err))) },
        })
        this.disposers.push(() => api.commands.unregister(id))
        return id
      }
      case 'extractors.register': {
        const spec = args[0] as { id?: unknown; label?: unknown; extensions?: unknown; version?: unknown }
        const key = String(spec?.id ?? '')
        const extensions = (Array.isArray(spec?.extensions) ? spec.extensions : [])
          .map(x => String(x).toLowerCase().replace(/^\./, '')).filter(x => /^[a-z0-9]{1,12}$/.test(x)).slice(0, 20)
        if (!key || extensions.length === 0) throw new Error('Extracteur : id et extensions attendus.')
        if (!api.extractors) throw new Error('Extracteurs indisponibles ici.')
        const remove = api.extractors.register({
          id: `${this.opts.id}:${key.slice(0, 100)}`,
          label: String(spec?.label ?? key).slice(0, 100),
          extensions,
          version: Number(spec?.version) || 1,
          // Jamais officiel : un plugin tiers ne tourne pas sur le serveur.
          official: false,
          extract: async (bytes, info) => {
            const copy = bytes.slice()
            return checkExtracted(await this.run('extract', key, { bytes: copy, info: { path: info.path } }, [copy.buffer]))
          },
        })
        this.disposers.push(remove)
        return true
      }
      case 'vault.list': {
        this.need('vault:read')
        const dir = String(args[0] ?? '')
        return (await api.vault.list(dir || undefined)).slice(0, 10_000)
      }
      case 'vault.read': {
        this.need('vault:read')
        const path = this.path(args[0])
        const id = api.vault.resolveDocumentId(path)
        return id ? api.vault.read(id) : api.vault.readDocumentByPath(path)
      }
      case 'vault.write': {
        this.need('vault:write')
        const path = this.path(args[0])
        const text = String(args[1] ?? '')
        if (text.length > 5 * 1024 * 1024) throw new Error('Texte trop long (5 Mio au plus).')
        this.throttleWrites()
        let id = api.vault.resolveDocumentId(path)
        if (!id) {
          if (!api.vault.createFile) throw new Error('Ce vault ne permet pas de créer un fichier.')
          await api.vault.createFile(path)
          id = await idAfterCreate(api, path)
        }
        if (api.vault.editText && path.toLowerCase().endsWith('.md')) await api.vault.editText(id, () => text)
        else await api.vault.write(id, text)
        return true
      }
      case 'query': {
        this.need('vault:read')
        if (!api.query) throw new Error('Aucun moteur de requêtes : ouvrez un vault.')
        return JSON.parse(JSON.stringify(await api.query.query(args[0] as never))) as unknown
      }
      case 'open': {
        this.need('ui:editor')
        await api.workspace.openFile(this.path(args[0]))
        return true
      }
      case 'notify': {
        this.opts.notify?.(`${this.opts.name} : ${String(args[0] ?? '').slice(0, 300)}`)
        return true
      }
      default:
        throw new Error(`Fonction inconnue : ${fn}`)
    }
  }

  private throttleWrites(): void {
    const now = Date.now()
    this.writes = this.writes.filter(t => now - t < 60_000)
    if (this.writes.length >= MAX_FRAME_WRITES_PER_MINUTE) throw new Error('Trop d’écritures : réessayez dans une minute.')
    this.writes.push(now)
  }
}

/**
 * Id d'une note qui vient d'etre creee : la liste des documents du vault peut
 * suivre la creation d'un instant.
 */
export async function idAfterCreate(api: Pick<PluginAPI, 'vault'>, path: string, timeoutMs = 5000): Promise<string> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const id = api.vault.resolveDocumentId(path)
    if (id) return id
    if (Date.now() > until) throw new Error(`Note introuvable après sa création : ${path}`)
    await new Promise(r => setTimeout(r, 50))
  }
}

/** Le resultat d'une extraction, tel que l'index l'attend ; le reste est ignore. */
export function checkExtracted(v: unknown): ExtractedContent {
  const o = (v ?? {}) as { title?: unknown; sections?: unknown }
  if (!Array.isArray(o.sections)) throw new Error('Extraction : { sections: [{ text }] } attendu.')
  return {
    title: typeof o.title === 'string' ? o.title.slice(0, 500) : undefined,
    sections: o.sections.slice(0, 10_000).map(s => {
      const x = (s ?? {}) as { heading?: unknown; text?: unknown }
      return { heading: typeof x.heading === 'string' ? x.heading.slice(0, 500) : undefined, text: String(x.text ?? '') }
    }),
  }
}
