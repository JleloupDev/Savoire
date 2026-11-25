// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Une animation tourne dans une iframe ISOLEE, comme un board : son code
// vient d'un membre du vault et s'execute chez les autres.
//
//  - sandbox="allow-scripts" sans allow-same-origin : origine opaque, aucun
//    acces a la page de Savoire, a ses cookies, a son stockage ;
//  - Content-Security-Policy en tete : aucun reseau. anime.js est ecrit
//    dans le document (pas telecharge), comme le code de l'animation ;
//  - Savoire ne lui envoie que des ordres de lecture (lire, pause, aller a
//    un timecode, boucle, viser un element) ; l'animation ne renvoie que son
//    etat (duree, temps, fin, taille, erreurs, element vise). Elle n'a aucune
//    API vers le vault.
import { animationParts, checkKeyframes } from './format'

export const ANIM_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

/** Taille max d'un message accepte de l'animation (octets JSON, approximatif). */
export const MAX_MESSAGE = 16 * 1024

/** Messages de la page cadre (version bureau et /frame.html), communs avec les boards. */
export const FRAME_READY = 'savoire-board-ready'
export const FRAME_BOOT = 'savoire-board-boot'

const THEME_VARS = ['--text', '--text-muted', '--bg-base', '--bg-surface', '--bg-elevated', '--border', '--accent', '--accent-text', '--font-ui', '--font-mono', '--red', '--green']

/** Couleurs et police de l'appli, en variables CSS (lues la ou l'animation s'affiche). */
export function themeCss(root: Element | null = typeof document !== 'undefined' ? document.documentElement : null): string {
  const style = root && typeof getComputedStyle === 'function' ? getComputedStyle(root) : null
  const vars = THEME_VARS.map(v => {
    const value = style?.getPropertyValue(v).trim()
    return value ? `${v}:${value.replace(/[<>{};]/g, '')};` : ''
  }).join('')
  return `:root{${vars}color-scheme:light dark}
html,body{margin:0;padding:0;background:transparent}
body{font-family:var(--font-ui,system-ui,sans-serif);color:var(--text,#1e1e2e);overflow:hidden}
.savoire-anim-pick *{cursor:crosshair!important}
.savoire-anim-hover{outline:2px dashed #f59e0b!important;outline-offset:2px}
.savoire-anim-mark{outline:3px solid #f59e0b!important;outline-offset:3px;transition:outline-color .3s}`
}

/** Le pont avec Savoire : la frise, les ordres de lecture, l'etat. Avant le code. */
function bridgeScript(channel: string): string {
  return `(()=>{const ch=${JSON.stringify(channel)};const post=m=>{try{parent.postMessage(Object.assign({ch},m),'*')}catch(e){}};
const A=window.anime;if(!A){post({t:'error',m:'anime.js absent'});return}
let loop=false,last=-1,picking=false,hovered=null;
const tl=A.createTimeline({autoplay:false,
onUpdate:s=>{const t=Math.round(s.currentTime);if(t!==last){last=t;post({t:'time',ms:t,d:Math.round(s.duration)})}},
onComplete:()=>{post({t:'end'});if(loop)tl.restart()}});
Object.defineProperty(window,'timeline',{value:tl});
const sel=el=>{if(!el||el===document.body||el===document.documentElement)return'body';if(el.id)return'#'+CSS.escape(el.id);
const parts=[];for(let e=el;e&&e!==document.body;e=e.parentElement){let s=e.tagName.toLowerCase();if(e.id){parts.unshift('#'+CSS.escape(e.id));break}
const p=e.parentElement;if(p){const same=[...p.children].filter(c=>c.tagName===e.tagName);if(same.length>1)s+=':nth-of-type('+(same.indexOf(e)+1)+')'}parts.unshift(s)}return parts.join(' > ')};
const label=el=>{const c=el.getAttribute&&typeof el.className==='string'?el.className.trim().split(/\\s+/).filter(x=>!x.startsWith('savoire-anim')).slice(0,2):[];return el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(c.length?'.'+c.join('.'):'')};
addEventListener('message',e=>{if(e.source!==parent)return;const m=e.data;if(!m||m.ch!==ch)return;
if(m.t==='play'){if(tl.completed||tl.currentTime>=tl.duration)tl.restart();else tl.play()}
else if(m.t==='pause')tl.pause();
else if(m.t==='seek'){tl.pause();tl.seek(Math.max(0,Math.min(tl.duration,Number(m.ms)||0)));post({t:'time',ms:Math.round(tl.currentTime),d:Math.round(tl.duration)})}
else if(m.t==='loop')loop=!!m.on;
else if(m.t==='pick'){picking=!!m.on;document.documentElement.classList.toggle('savoire-anim-pick',picking);if(!picking&&hovered){hovered.classList.remove('savoire-anim-hover');hovered=null}}
else if(m.t==='mark'){try{const el=document.querySelector(String(m.sel));if(el){el.classList.add('savoire-anim-mark');setTimeout(()=>el.classList.remove('savoire-anim-mark'),1600)}}catch(e){}}});
document.addEventListener('mouseover',e=>{if(!picking)return;if(hovered)hovered.classList.remove('savoire-anim-hover');hovered=e.target;hovered.classList&&hovered.classList.add('savoire-anim-hover')},true);
document.addEventListener('click',e=>{if(!picking)return;e.preventDefault();e.stopPropagation();const el=e.target;if(hovered)hovered.classList.remove('savoire-anim-hover');post({t:'picked',sel:sel(el),label:label(el)})},true);
window.__savoireTracks=k=>{if(!k||!Array.isArray(k.tracks))return;for(const t of k.tracks){try{const{target,at,...p}=t;tl.add(target,p,at===undefined?0:at)}catch(e){post({t:'error',m:'Piste '+(t&&t.target)+' : '+(e&&e.message||e)})}}};
window.__savoireReady=()=>post({t:'ready',d:Math.round(tl.duration)});
const size=()=>post({t:'size',h:Math.ceil(document.documentElement.getBoundingClientRect().height)});
addEventListener('load',()=>{size();post({t:'ready',d:Math.round(tl.duration)})});new ResizeObserver(size).observe(document.documentElement);
addEventListener('error',e=>post({t:'error',m:String(e.message||e)}));
addEventListener('unhandledrejection',e=>post({t:'error',m:String(e.reason&&e.reason.message||e.reason)}));
})()`
}

/** Ferme une balise </script> qui se trouverait dans un texte mis dans un script. */
const inScript = (s: string) => s.replace(/<\/(script)/gi, '<\\/$1')

/**
 * Le document de l'iframe : CSP, theme, anime.js, pont, styles, scene, images
 * cles, code. `anime` : le texte de anime.js (UMD), lu a part (anime.ts).
 */
export function buildSrcdoc(source: string, opts: { channel: string; anime: string; theme?: string }): string {
  const parts = animationParts(source)
  const keyframes = checkKeyframes(parts.keyframes) === null && parts.keyframes && typeof parts.keyframes === 'object' ? parts.keyframes : null
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${ANIM_CSP}">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<style>${opts.theme ?? themeCss()}</style>`
    + `<script>${inScript(opts.anime)}</script>`
    + `<script>${bridgeScript(opts.channel)}</script>`
    + `<style>${parts.css.replace(/<\/style/gi, '<\\/style')}</style>`
    + `</head><body>${parts.html}`
    + `<script>window.keyframes=${inScript(JSON.stringify(keyframes))};window.__savoireTracks(window.keyframes)</script>`
    + `<script>${inScript(parts.script)}\n</script>`
    + `<script>window.__savoireReady()</script>`
    + '</body></html>'
}

export function randomChannel(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Page « cadre » servie avec sa propre CSP (bureau : protocole savoire-board ;
 * web : /frame.html). Une iframe srcdoc heriterait de la CSP de l'appli, qui
 * interdit le JavaScript en ligne. Null : srcdoc (tests, page sans CSP).
 */
let frameUrl: string | null = null

export function setAnimationFrameUrl(url: string | null): void {
  frameUrl = url
}

export function animationFrameUrl(): string | null {
  return frameUrl
}
