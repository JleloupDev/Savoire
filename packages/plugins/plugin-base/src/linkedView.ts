// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Base integree dans une note, modifiable sur place (« vue liee » de
// Notion) : ![[db.base#Vue]] monte la vraie vue de la base (cellules,
// lignes, filtres), sur l'arbre partage du document de la base.
//
// La vue nommee est une vue de la base : la modifier ici la modifie
// partout. « Vue propre a cette page » la copie en vue liee (masquee dans
// les onglets de la base) et reecrit le lien de la note vers elle : ses
// filtres et tris ne valent alors que pour cette page.
//
// Sans edition de la note (lecture seule, page partagee), ou sans arbre
// partage, la note garde le rendu en lecture seule (embed.ts).
import { BLOCK_DESTROY_EVENT } from '@savoire/plugin-api'
import type { BlockContext, FileView, PluginAPI } from '@savoire/plugin-api'
import { h } from './dom'
import { resolveBase } from './queryBlock'
import { createBaseView } from './view'
import type { BaseEmbedTarget } from './embed'

/** Le lien d'une base dans une ligne de note, pointe vers une autre vue. */
export function retargetEmbed(line: string, view: string): string {
  return line.replace(/!\[\[([^\]|#]+\.base)(?:#[^\]|]*)?(\|[^\]]*)?\]\]/i, (_m, path: string, alias: string | undefined) => `![[${path}#${view}${alias ?? ''}]]`)
}

/** La vue liee est-elle possible ici ? */
export function canLinkView(api: PluginAPI | undefined, ctx: BlockContext | undefined): boolean {
  return !!api?.vault.openTree && !!api.vault.editText && !!ctx?.edit && !!ctx.locate
}

export function renderLinkedView(target: BaseEmbedTarget, api: PluginAPI, ctx: BlockContext): HTMLElement {
  const el = h('div', { class: 'base-linked', 'data-testid': 'base-linked' })
  const inner = h('div', { class: 'base-linked-inner' }, h('div', { class: 'base-q-message' }, '…'))
  el.append(inner)
  // La vue garde ses touches et ses clics : l'editeur de la note ne les voit pas.
  for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'mousedown', 'paste', 'copy', 'cut', 'drop', 'dragover']) {
    el.addEventListener(type, e => e.stopPropagation())
  }
  let view: (FileView & { destroy(): void }) | null = null
  let baseId = ''
  let dead = false
  el.addEventListener(BLOCK_DESTROY_EVENT, () => {
    dead = true
    view?.destroy()
    if (baseId) api.vault.closeTree?.(baseId)
  }, { once: true })
  void (async () => {
    const base = await resolveBase(api, target.path)
    if (dead) return
    if (!base) { inner.replaceChildren(h('div', { class: 'base-q-message base-q-bad', 'data-testid': 'base-embed-error' }, `⚠ Base introuvable : « ${target.path} »`)); return }
    const tree = await api.vault.openTree!(base.id)
    if (dead) { api.vault.closeTree?.(base.id); return }
    baseId = base.id
    view = createBaseView(base.path, {
      vaultId: api.vault.getVaultId?.() ?? '',
      path: base.path,
      tree,
      vault: api.vault,
      ...(api.vault.sharedData ? { shared: api.vault.sharedData(base.id) } : {}),
    }, api, {
      embedded: {
        view: target.view,
        openBase: () => void api.workspace.openFile(base.path),
        ownView: name => {
          const loc = ctx.locate?.(el)
          if (!loc || !ctx.edit) return false
          ctx.edit(loc.from, loc.to, retargetEmbed(loc.text, name))
          return true
        },
      },
    })
    view.mount(inner)
  })().catch(err => {
    inner.replaceChildren(h('div', { class: 'base-q-message base-q-bad', 'data-testid': 'base-embed-error' }, `⚠ ${err instanceof Error ? err.message : String(err)}`))
  })
  return el
}
