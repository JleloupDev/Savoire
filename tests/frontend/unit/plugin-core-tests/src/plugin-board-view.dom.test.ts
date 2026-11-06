// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Un board vide ne recoit jamais l'exemple tout seul : son texte partage peut
// etre encore vide le temps de la synchro, et l'exemple s'ajoutait alors au
// vrai contenu (deux scripts, « Identifier already declared »).
import { describe, it, expect } from 'vitest'
import { createBoardView, BOARD_TEMPLATE } from '@savoire/plugin-board'
import type { FileContext, ISharedText, TextDelta } from '@savoire/plugin-api'

function sharedText(initial = ''): ISharedText & { value: string } {
  const t = {
    value: initial,
    toString() { return t.value },
    get length() { return t.value.length },
    insert(i: number, s: string) { t.value = t.value.slice(0, i) + s + t.value.slice(i) },
    delete(i: number, n: number) { t.value = t.value.slice(0, i) + t.value.slice(i + n) },
    applyDelta(delta: TextDelta) {
      let pos = 0
      for (const op of delta) {
        if ('retain' in op) pos += op.retain
        else if ('delete' in op) t.delete(pos, op.delete)
        else { t.insert(pos, op.insert); pos += op.insert.length }
      }
    },
    onChange() { return () => {} },
  }
  return t as unknown as ISharedText & { value: string }
}

describe('board : exemple', () => {
  it('ouvert vide : rien d\'insere ; le bouton insere l\'exemple', () => {
    const text = sharedText('')
    const view = createBoardView('b.board', { vaultId: 'v', path: 'b.board', text } as FileContext, undefined)
    const el = document.createElement('div')
    document.body.appendChild(el)
    view.mount(el)
    expect(text.value).toBe('')
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="board-example"]')!
    expect(btn.hidden).toBe(false)
    btn.click()
    expect(text.value).toBe(BOARD_TEMPLATE)
    expect(btn.hidden).toBe(true)
    view.unmount?.()
  })

  it('ouvert avec du contenu : pas de bouton', () => {
    const text = sharedText('<p>mon board</p>')
    const view = createBoardView('b.board', { vaultId: 'v', path: 'b.board', text } as FileContext, undefined)
    const el = document.createElement('div')
    view.mount(el)
    expect(el.querySelector<HTMLButtonElement>('[data-testid="board-example"]')!.hidden).toBe(true)
    expect(text.value).toBe('<p>mon board</p>')
    view.unmount?.()
  })
})
