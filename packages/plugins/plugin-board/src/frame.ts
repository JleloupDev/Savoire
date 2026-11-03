// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un board tourne dans une iframe ISOLEE. Un vault est partage : le code d'un
// membre s'execute chez les autres, il ne doit rien pouvoir faire en leur nom
// hors de l'API ci-dessous.
//
//  - sandbox="allow-scripts" sans allow-same-origin : origine opaque. Pas
//    d'acces a la page de Savoire, ni a ses cookies, son stockage, son jeton ;
//    pas de fenetres, de formulaires, de navigation de la page ;
//  - Content-Security-Policy en tete du document : aucun reseau (fetch,
//    WebSocket, images ou polices distantes). Le code et les styles sont ceux
//    du board, en ligne ;
//  - Savoire ne repond qu'aux messages de CETTE iframe, sur un canal tire au
//    sort, et seulement aux methodes de l'API (host.ts) : requetes
//    declaratives, ouvrir une note, ecrire une propriete (avec l'accord de la
//    personne qui regarde le board).
//
// Limite connue : un board peut toujours se recharger lui-meme vers une
// adresse externe (la CSP ne sait pas l'interdire). Il ne voit que ce que la
// personne voit deja du vault, mais pourrait l'envoyer ainsi : le board est
// du code, a n'ouvrir que dans un vault de confiance.

/** Taille max d'un message accepte du board (octets JSON, approximatif). */
export const MAX_MESSAGE = 256 * 1024

export const BOARD_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

/** Couleurs et police de l'appli, passees au board en variables CSS. */
const THEME_VARS = ['--text', '--text-muted', '--text-faint', '--bg-base', '--bg-surface', '--bg-elevated', '--border', '--accent', '--accent-text', '--font-ui', '--font-mono', '--red', '--green']

export function themeCss(root: Element | null = typeof document !== 'undefined' ? document.documentElement : null): string {
  const style = root && typeof getComputedStyle === 'function' ? getComputedStyle(root) : null
  const vars = THEME_VARS.map(v => {
    const value = style?.getPropertyValue(v).trim()
    return value ? `${v}:${value.replace(/[<>{};]/g, '')};` : ''
  }).join('')
  return `:root{${vars}color-scheme:light dark}
body{margin:0;padding:12px;font-family:var(--font-ui,system-ui,sans-serif);font-size:14px;color:var(--text,#1e1e2e);background:transparent}
a{color:var(--accent,#7c3aed)}`
}

/** Le pont vers Savoire, injecte avant le code du board (window.savoire). */
function bridgeScript(channel: string, readOnly: boolean): string {
  return `(()=>{const ch=${JSON.stringify(channel)};let n=0;const pend=new Map(),watches=new Map();
const post=m=>parent.postMessage(Object.assign({ch},m),'*');
addEventListener('message',e=>{if(e.source!==parent)return;const m=e.data;if(!m||m.ch!==ch)return;
if(m.t==='res'){const p=pend.get(m.id);if(p){pend.delete(m.id);m.ok?p[0](m.v):p[1](new Error(m.e))}}
else if(m.t==='watch'){const w=watches.get(m.id);if(w){m.ok?w[0](m.v):w[1]&&w[1](new Error(m.e))}}});
const call=(fn,args)=>new Promise((res,rej)=>{const id=++n;pend.set(id,[res,rej]);post({t:'call',id,fn,args})});
window.savoire=Object.freeze({
query:q=>call('query',[q]),
watch(q,cb,onError){const id=++n;watches.set(id,[cb,onError]);post({t:'watch',id,q});return()=>{watches.delete(id);post({t:'unwatch',id})}},
open:p=>call('open',[p]),
setProperty:(target,key,value)=>call('setProperty',[target,key,value]),
createPage:(base,title,values)=>call('createPage',[base,title,values||{}]),
readOnly:${readOnly ? 'true' : 'false'}});
document.addEventListener('click',e=>{const a=e.target&&e.target.closest&&e.target.closest('[data-open]');if(a){e.preventDefault();savoire.open(a.getAttribute('data-open'))}});
const size=()=>post({t:'size',h:Math.ceil(document.documentElement.getBoundingClientRect().height)});
addEventListener('load',size);new ResizeObserver(size).observe(document.documentElement);
addEventListener('error',e=>post({t:'error',m:String(e.message||e)}));
addEventListener('unhandledrejection',e=>post({t:'error',m:String(e.reason&&e.reason.message||e.reason)}));
})()`
}

/** Le document de l'iframe : CSP, theme, pont, puis le board tel quel. */
export function buildSrcdoc(source: string, opts: { channel: string; readOnly: boolean; theme?: string }): string {
  // Le pont et la CSP passent AVANT tout le contenu du board : une balise
  // <meta> CSP posee plus loin ne peut que restreindre davantage.
  const head = `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${BOARD_CSP}">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<style>${opts.theme ?? themeCss()}</style>`
    + `<script>${bridgeScript(opts.channel, opts.readOnly)}</script></head><body>`
  return head + source + '</body></html>'
}

export function randomChannel(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}
