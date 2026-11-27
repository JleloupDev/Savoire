// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le cadre d'une application (.app) : comme un board (plugin-board), une
// iframe ISOLEE (sandbox="allow-scripts", origine opaque : rien de la page de
// Savoire, ni cookies, ni stockage, ni jeton). En plus du board :
//
//  - des modules JavaScript : les fichiers .js/.mjs/.css du dossier de
//    l'application arrivent avec elle et deviennent des adresses blob:
//    creees DANS le cadre ; une carte d'import les nomme « app/<chemin> » ;
//  - React (react, react-dom, react-dom/client, react/jsx-runtime), fourni
//    par Savoire de la meme facon : l'application n'a pas a l'embarquer ;
//  - des workers (worker-src blob:) : ils heritent de la politique du cadre,
//    donc pas plus de reseau que lui. Le cadre les compte et Savoire peut les
//    arreter ;
//  - toujours aucun reseau : connect-src n'admet que blob: et data:.
//
// Limite connue (comme les boards) : le cadre peut se recharger vers une
// adresse externe. A n'ouvrir que dans un vault de confiance.

import { rewriteModuleImports } from './paths'

/** Politique du document de l'application (et de sa page cadre). */
export const APP_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline' blob:",
  'img-src data: blob:',
  'font-src data: blob:',
  'media-src data: blob:',
  'connect-src blob: data:',
  'worker-src blob:',
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

/** Bibliotheques fournies au cadre, par nom d'import. */
export type AppLibraries = Record<string, string>

/** Ce qui part avec l'application : son code, ses modules, ses bibliotheques. */
export interface AppDocumentInput {
  /** Le fichier .app (HTML : le corps de la page, ou une page entiere). */
  source: string
  /** Modules et styles du dossier : chemin relatif -> texte (imports deja reecrits). */
  files: Record<string, string>
  libraries: AppLibraries
  channel: string
  readOnly: boolean
  app: { path: string; folder: string; name: string }
  user: { id: string; name: string } | null
  theme?: string
}

const THEME_VARS = ['--text', '--text-muted', '--text-faint', '--bg-base', '--bg-surface', '--bg-elevated', '--border', '--accent', '--accent-text', '--font-ui', '--font-mono', '--red', '--green']

export function appThemeCss(root: Element | null = typeof document !== 'undefined' ? document.documentElement : null): string {
  const style = root && typeof getComputedStyle === 'function' ? getComputedStyle(root) : null
  const vars = THEME_VARS.map(v => {
    const value = style?.getPropertyValue(v).trim()
    return value ? `${v}:${value.replace(/[<>{};]/g, '')};` : ''
  }).join('')
  return `:root{${vars}color-scheme:light dark}
html,body{margin:0;height:100%}
body{font-family:var(--font-ui,system-ui,sans-serif);font-size:14px;color:var(--text,#1e1e2e);background:var(--bg-base,transparent)}
a{color:var(--accent,#7c3aed)}`
}

/** Le pont vers Savoire (window.savoire), avant tout code de l'application. */
function bridgeScript(input: AppDocumentInput): string {
  const info = JSON.stringify({ app: input.app, user: input.user, readOnly: input.readOnly })
  return `(()=>{const ch=${JSON.stringify(input.channel)};const info=${info};let n=0;const pend=new Map(),watches=new Map(),fileWatchers=new Set();
const post=(m,tr)=>parent.postMessage(Object.assign({ch},m),'*',tr||[]);
addEventListener('message',e=>{if(e.source!==parent)return;const m=e.data;if(!m||m.ch!==ch)return;
if(m.t==='res'){const p=pend.get(m.id);if(p){pend.delete(m.id);m.ok?p[0](m.v):p[1](new Error(m.e))}}
else if(m.t==='watch'){const w=watches.get(m.id);if(w){m.ok?w[0](m.v):w[1]&&w[1](new Error(m.e))}}
else if(m.t==='files'){for(const c of m.changes||[]){const u=urls.get(c.path);if(u){URL.revokeObjectURL(u);urls.delete(c.path)}}for(const cb of fileWatchers){try{cb(m.changes)}catch(err){post({t:'error',m:String(err&&err.message||err)})}}}
else if(m.t==='stop-workers'){for(const w of [...live])w.terminate()}});
const call=(fn,args)=>new Promise((res,rej)=>{const id=++n;pend.set(id,[res,rej]);post({t:'call',id,fn,args})});
const urls=new Map();
const files=Object.freeze({
list:(dir,opts)=>call('files.list',[dir||'',!!(opts&&opts.recursive)]),
read:p=>call('files.read',[p]),
readJSON:async p=>JSON.parse(await call('files.read',[p])),
bytes:async(p,o)=>{const r=await call('files.bytes',o&&typeof o.start==='number'?[p,o.start,o.end]:[p]);return r.bytes.buffer.slice(r.bytes.byteOffset,r.bytes.byteOffset+r.bytes.byteLength)},
size:p=>call('files.size',[p]),
url:async p=>{if(urls.has(p))return urls.get(p);const r=await call('files.bytes',[p]);const u=URL.createObjectURL(new Blob([r.bytes],{type:r.mime}));urls.set(p,u);return u},
write:(p,text)=>call('files.write',[p,String(text)]),
writeBytes:(p,data)=>call('files.writeBytes',[p,data instanceof Blob?null:data]),
writeJSON:(p,v)=>call('files.write',[p,JSON.stringify(v,null,2)+'\\n']),
remove:p=>call('files.remove',[p]),
move:(from,to)=>call('files.move',[from,to]),
watch(cb){fileWatchers.add(cb);if(fileWatchers.size===1)post({t:'call',id:++n,fn:'files.watch',args:[]});return()=>{fileWatchers.delete(cb);if(!fileWatchers.size)post({t:'call',id:++n,fn:'files.unwatch',args:[]})}}});
window.savoire=Object.freeze({
app:Object.freeze(info.app),user:info.user,readOnly:info.readOnly,files,
query:q=>call('query',[q]),
watch(q,cb,onError){const id=++n;watches.set(id,[cb,onError]);post({t:'watch',id,q});return()=>{watches.delete(id);post({t:'unwatch',id})}},
open:p=>call('open',[p]),
setProperty:(target,key,value)=>call('setProperty',[target,key,value]),
createPage:(base,title,values)=>call('createPage',[base,title,values||{}]),
createRow:(base,title,values)=>call('createRow',[base,title,values||{}]),
notify:(message,type)=>call('notify',[String(message),type||'info']),
reload:()=>call('app.reload',[])});
const W=window.Worker,live=new Set();
if(W){const report=()=>post({t:'workers',n:live.size});
window.Worker=function(url,opts){const w=new W(url,opts);live.add(w);const stop=w.terminate.bind(w);w.terminate=()=>{stop();if(live.delete(w))report()};report();return w};
window.Worker.prototype=W.prototype}
addEventListener('error',e=>post({t:'error',m:String(e.message||e)}));
addEventListener('unhandledrejection',e=>post({t:'error',m:String(e.reason&&e.reason.message||e.reason)}));
})()`
}

/** Cree les adresses blob: des modules et des bibliotheques, puis la carte d'import. */
const LOADER = `(()=>{const d=JSON.parse(document.getElementById('savoire-app-files').textContent);const map={};
const mime=p=>/\\.css$/i.test(p)?'text/css':'text/javascript';
for(const [name,code] of Object.entries(d.libraries))map[name]=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
for(const [p,code] of Object.entries(d.files)){const u=URL.createObjectURL(new Blob([code],{type:mime(p)}));map['app/'+p]=u}
document.write('<script type="importmap">'+JSON.stringify({imports:map}).replace(/</g,'\\\\u003c')+'<\\/script>');
window.__savoireAppUrls=map})()`

const escapeJsonForHtml = (json: string) => json.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

/** Un texte a mettre dans une balise <script> ou <style> sans la fermer. */
const inlineSafe = (text: string, tag: 'script' | 'style') => text.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1')

/**
 * Le HTML de l'application, avec ses references aux fichiers du dossier
 * remplacees : <script type="module" src="app/x.js"> devient un import (la
 * carte d'import le trouve), un script classique ou une feuille de style est
 * recopie en ligne.
 */
export function rewriteAppHtml(source: string, files: Record<string, string>): string {
  const target = (raw: string): string | null => {
    const p = raw.replace(/^\.\//, '').replace(/^app\//, '')
    return Object.prototype.hasOwnProperty.call(files, p) ? p : null
  }
  return source
    // Module en ligne : ses imports relatifs (./main.js) visent le dossier.
    .replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (all, attrs: string, code: string) => {
      if (/\bsrc\s*=/i.test(attrs) || !/\btype\s*=\s*["']?module/i.test(attrs)) return all
      return `<script${attrs}>${rewriteModuleImports('index.app', code)}</script>`
    })
    .replace(/<script\b([^>]*)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>\s*<\/script>/gi, (all, a: string, _q: string, src: string, b: string) => {
      const p = target(src)
      if (!p) return all
      const attrs = `${a} ${b}`
      if (/\btype\s*=\s*["']?module/i.test(attrs)) return `<script type="module">import ${JSON.stringify(`app/${p}`)}</script>`
      return `<script>${inlineSafe(files[p], 'script')}</script>`
    })
    .replace(/<link\b([^>]*)\bhref\s*=\s*(["'])([^"']+)\2([^>]*)>/gi, (all, a: string, _q: string, href: string, b: string) => {
      if (!/\brel\s*=\s*["']?stylesheet/i.test(`${a} ${b}`)) return all
      const p = target(href)
      return p ? `<style>${inlineSafe(files[p], 'style')}</style>` : all
    })
}

/** Le document de l'iframe : politique, theme, pont, modules, puis l'application. */
export function buildAppDocument(input: AppDocumentInput): string {
  const payload = escapeJsonForHtml(JSON.stringify({ files: input.files, libraries: input.libraries }))
  const title = input.app.name.replace(/[<>&"]/g, '')
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${APP_CSP}">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${title}</title>`
    + `<style>${input.theme ?? appThemeCss()}</style>`
    + `<script>${bridgeScript(input)}</script>`
    + `<script type="application/json" id="savoire-app-files">${payload}</script>`
    + `<script>${LOADER}</script>`
    + `</head><body>${rewriteAppHtml(input.source, input.files)}</body></html>`
}

/**
 * Page cadre des applications (sa propre politique, plus large que celle des
 * boards : modules blob:, workers). Version web : /app-frame.html ; bureau :
 * protocole savoire-board, chemin /app. Null : srcdoc (tests).
 */
let appFrameUrl: string | null = null

export function setAppFrameUrl(url: string | null): void {
  appFrameUrl = url
}

export function getAppFrameUrl(): string | null {
  return appFrameUrl
}
