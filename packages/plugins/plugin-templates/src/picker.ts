// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Petite liste a choisir (un modele, un dossier) : un champ qui filtre, les
// fleches pour se deplacer, Entree pour choisir, Echap pour fermer. Les
// couleurs sont celles du theme de l'application.

export interface PickItem {
  value: string
  label: string
  detail?: string
}

/** Montre la liste ; rend l'element choisi, ou null si la personne ferme. */
export function pick(items: readonly PickItem[], placeholder: string, doc: Document = document): Promise<PickItem | null> {
  return new Promise(resolve => {
    const overlay = doc.createElement('div')
    overlay.className = 'sv-overlay'
    overlay.dataset.testid = 'templates-picker'
    overlay.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.35);display:flex;justify-content:center;align-items:flex-start;padding-top:14vh'
    const box = doc.createElement('div')
    box.setAttribute('role', 'dialog')
    box.style.cssText = 'width:520px;max-width:92vw;background:var(--bg-surface,#fff);color:var(--text,#111);border:1px solid var(--border,#ddd);border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.25);overflow:hidden;font-family:var(--font-ui,sans-serif)'
    const input = doc.createElement('input')
    input.placeholder = placeholder
    input.dataset.testid = 'templates-picker-input'
    input.style.cssText = 'width:100%;box-sizing:border-box;padding:12px 14px;border:none;border-bottom:1px solid var(--border,#ddd);background:transparent;color:inherit;font:inherit;outline:none'
    const list = doc.createElement('div')
    list.style.cssText = 'max-height:50vh;overflow-y:auto;padding:4px'
    box.append(input, list)
    overlay.append(box)

    let shown: PickItem[] = [...items]
    let index = 0
    const close = (chosen: PickItem | null) => {
      overlay.remove()
      resolve(chosen)
    }
    const render = () => {
      list.replaceChildren()
      if (!shown.length) {
        const empty = doc.createElement('div')
        empty.textContent = 'Rien ne correspond.'
        empty.style.cssText = 'padding:8px 10px;color:var(--text-muted,#666);font-size:.85rem'
        list.append(empty)
      }
      shown.forEach((item, i) => {
        const row = doc.createElement('div')
        row.dataset.testid = 'templates-picker-item'
        row.style.cssText = `padding:7px 10px;border-radius:6px;cursor:pointer;${i === index ? 'background:var(--bg-hover,#eee);' : ''}`
        const label = doc.createElement('div')
        label.textContent = item.label
        row.append(label)
        if (item.detail) {
          const d = doc.createElement('div')
          d.textContent = item.detail
          d.style.cssText = 'font-size:.75rem;color:var(--text-muted,#666)'
          row.append(d)
        }
        row.addEventListener('mousedown', e => { e.preventDefault(); close(item) })
        list.append(row)
      })
    }
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase()
      shown = items.filter(i => !q || `${i.label} ${i.detail ?? ''}`.toLowerCase().includes(q))
      index = 0
      render()
    })
    input.addEventListener('keydown', e => {
      e.stopPropagation()
      if (e.key === 'Escape') { e.preventDefault(); close(null) }
      else if (e.key === 'ArrowDown') { e.preventDefault(); index = Math.min(shown.length - 1, index + 1); render() }
      else if (e.key === 'ArrowUp') { e.preventDefault(); index = Math.max(0, index - 1); render() }
      else if (e.key === 'Enter') { e.preventDefault(); close(shown[index] ?? null) }
    })
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(null) })
    render()
    doc.body.append(overlay)
    input.focus()
  })
}
