// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Demande d'accord avant la premiere ecriture d'un board, dans son cadre.

export function confirmIn(container: HTMLElement, what: string): Promise<boolean> {
  return new Promise(resolve => {
    const box = document.createElement('div')
    box.className = 'board-confirm'
    box.dataset.testid = 'board-confirm'
    const text = document.createElement('div')
    text.append('Ce board veut modifier le vault. Première demande : ')
    const code = document.createElement('code')
    code.textContent = what.slice(0, 300)
    text.append(code)
    const actions = document.createElement('div')
    actions.className = 'board-confirm-actions'
    const button = (label: string, testid: string, answer: boolean) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = answer ? 'board-btn board-btn-on' : 'board-btn'
      b.dataset.testid = testid
      b.textContent = label
      b.addEventListener('mousedown', e => e.stopPropagation())
      b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); box.remove(); resolve(answer) })
      return b
    }
    actions.append(button('Autoriser ce board', 'board-confirm-yes', true), button('Refuser', 'board-confirm-no', false))
    box.append(text, actions)
    container.append(box)
  })
}
