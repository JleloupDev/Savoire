// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Animation integree : ![[Intro.anim]] dans une note, une diapositive, une
// page partagee. Meme lecteur isole que dans son fichier. Elle se joue des
// qu'elle est visible (une diapositive qui s'affiche la lance), sauf
// ![[Intro.anim|pause]] ; ![[Intro.anim|boucle]] la rejoue sans fin ;
// ![[Intro.anim|sans-barre]] cache la barre de lecture.
//
// Taille : l'animation garde sa hauteur dans une note. La ou la place est
// comptee (une diapositive), le lieu peut la faire retrecir (data-fit) : la
// scene est alors reduite a l'echelle, entiere et centree, au lieu d'etre
// coupee ou de deborder.
import { BLOCK_DESTROY_EVENT, createIcon, type PluginAPI } from '@savoire/plugin-api'
import type { AnimEmbed } from './format'
import { AnimationPlayer } from './player'
import { ensureStyle } from './style'
import { Transport } from './transport'

export const EMBED_MIN_HEIGHT = 40
export const EMBED_MAX_HEIGHT = 1400
/** Plus petite hauteur d'une animation reduite pour tenir (une diapositive). */
export const EMBED_FIT_MIN = 120

/** L'animation : chemin exact, sinon par son nom (comme un lien [[...]]). */
export async function resolveAnimation(api: PluginAPI, name: string): Promise<{ id: string; path: string } | null> {
  const direct = api.vault.resolveDocumentId(name)
  if (direct) return { id: direct, path: name }
  const all = await api.vault.list().catch(() => [] as string[])
  const tree = api.vault.getFileTree?.() ?? []
  const lower = name.toLowerCase()
  const paths = [...all, ...tree.map(f => f.path)]
  const path = paths.find(p => p.toLowerCase() === lower) ?? paths.find(p => p.toLowerCase().endsWith(`/${lower}`))
  const id = path ? api.vault.resolveDocumentId(path) ?? tree.find(f => f.path === path)?.docId : undefined
  return path && id ? { id, path } : null
}

export function renderAnimationEmbed(embed: AnimEmbed, api: PluginAPI | undefined): HTMLElement {
  ensureStyle()
  const el = document.createElement('div')
  el.className = 'anim-embed'
  el.dataset.testid = 'anim-embed'
  // Export (PowerPoint...) : une ligne qui la nomme, pas sa barre de lecture.
  el.dataset.exportLabel = `Animation : ${embed.name}`
  // Peut retrecir pour tenir dans la place qu'on lui laisse.
  el.dataset.fit = 'contain'
  // Un bouton de la barre ne fait pas entrer l'editeur dans le bloc.
  el.addEventListener('mousedown', e => { if ((e.target as HTMLElement).closest?.('a, button, .anim-track')) e.stopPropagation() })
  const fail = (msg: string) => {
    const m = document.createElement('div')
    m.className = 'anim-embed-error'
    m.dataset.testid = 'anim-embed-error'
    m.textContent = `⚠ ${msg}`
    el.replaceChildren(m)
  }
  if (!api) { fail('Aucun vault ouvert.'); return el }
  let player: AnimationPlayer | null = null
  let observer: IntersectionObserver | null = null
  let sizer: ResizeObserver | null = null
  let dead = false
  el.addEventListener(BLOCK_DESTROY_EVENT, () => { dead = true; observer?.disconnect(); sizer?.disconnect(); player?.dispose(); player = null }, { once: true })

  void resolveAnimation(api, embed.name).then(async anim => {
    if (dead) return
    if (!anim) { fail(`Animation introuvable : « ${embed.name} »`); return }
    const status = document.createElement('span')
    status.dataset.testid = 'anim-embed-status'
    // La scene a sa hauteur naturelle ; la boite peut etre plus basse (le
    // lieu la fait retrecir) : la scene est alors reduite pour y tenir.
    const stage = document.createElement('div')
    stage.className = 'anim-embed-stage'
    stage.dataset.testid = 'anim-embed-stage'
    let natural = 160
    const fit = () => {
      const box = stage.clientHeight
      const scale = box > 0 && box < natural ? box / natural : 1
      p.frame.style.transform = scale < 1 ? `scale(${scale.toFixed(4)})` : ''
      el.dataset.scale = scale.toFixed(3)
    }
    const p = new AnimationPlayer(anim.path, {
      onReady: () => transport.update(),
      onTime: () => transport.update(),
      onEnd: () => transport.update(),
      onSize: h => {
        const next = Math.max(EMBED_MIN_HEIGHT, Math.min(EMBED_MAX_HEIGHT, h))
        if (next === natural) return
        natural = next
        p.frame.style.height = `${natural}px`
        stage.style.height = `${natural}px`
        stage.style.minHeight = `${Math.min(natural, EMBED_FIT_MIN)}px`
        fit()
      },
      onError: msg => { status.textContent = `⚠ ${msg}` },
    })
    p.frame.style.height = `${natural}px`
    stage.style.height = `${natural}px`
    stage.style.minHeight = `${Math.min(natural, EMBED_FIT_MIN)}px`
    stage.appendChild(p.frame)
    if (typeof ResizeObserver !== 'undefined') {
      sizer = new ResizeObserver(fit)
      sizer.observe(stage)
    }
    player = p
    p.setLoop(embed.loop)
    const transport = new Transport(p, { icons: api.icons, compact: true })
    const open = document.createElement('a')
    open.href = '#'
    open.append(createIcon(api.icons, 'clapperboard', { size: 13 }), anim.path.split('/').pop() ?? '')
    open.title = `Ouvrir ${anim.path}`
    open.addEventListener('click', e => { e.preventDefault(); void api.workspace.openFile(anim.path) })
    const foot = document.createElement('div')
    foot.className = 'anim-embed-foot'
    foot.append(open, status)
    el.replaceChildren(stage, ...(embed.controls ? [transport.el] : []), ...(embed.controls ? [foot] : []))
    const source = await api.vault.read(anim.id)
    if (dead) return
    await p.load(source, { play: false })
    // Se joue quand elle devient visible : la diapositive qui s'affiche, la note qu'on fait defiler.
    if (embed.autoplay) {
      if (typeof IntersectionObserver === 'undefined') { p.play(); return }
      let started = false
      observer = new IntersectionObserver(entries => {
        const visible = entries.some(e => e.isIntersecting)
        if (visible && !started) { started = true; p.play(); transport.update() }
        else if (!visible && started && p.state.playing) { p.pause(); started = false; transport.update() }
      }, { threshold: 0.4 })
      observer.observe(el)
    }
  }).catch(err => fail(String(err?.message ?? err)))
  return el
}
