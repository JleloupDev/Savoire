// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-base : confort du tableau (colonnes glissees et figees, selection
// et actions groupees, clavier, copier-coller, apercu lateral, ordre manuel,
// CSV).
import { describe, it, expect } from 'vitest'
import { parseFrontmatter } from '@savoire/plugin-api'
import { parseCsv, toCsv, parseCellText } from '@savoire/plugin-base'
import { cell, click, mount, tick, titles, world } from './baseHarness'

const NOTES = [
  { path: 'Projets/Alpha.md', text: '---\nstatus: En cours\npriority: 2\n---\n# Alpha\nCorps de la note.' },
  { path: 'Projets/Beta.md', text: '---\nstatus: Fait\npriority: 1\n---\n' },
  { path: 'Projets/Gamma.md', text: '---\nstatus: Fait\npriority: 3\n---\n' },
]

const heads = (el: HTMLElement) => Array.from(el.querySelectorAll('[data-testid="base-th"]')).map(t => (t as HTMLElement).dataset.key)

function dragEvent(type: string, data: Map<string, string>) {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', {
    value: { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '', get types() { return [...data.keys()] }, effectAllowed: '' },
  })
  return e
}

async function setup() {
  const w = world(NOTES)
  const a = w.member(0)
  a.types.set({ key: 'priority', type: 'number' })
  const m = await mount(w, 0, a.api)
  await tick(150)
  return { w, a, ...m }
}

describe('confort du tableau', () => {
  it('CSV : guillemets, separateurs, valeurs typees', () => {
    const text = toCsv([['Nom', 'Note'], ['A, b', 'dit "oui"'], ['C', 'ligne\nsuivante']])
    expect(parseCsv(text)).toEqual([['Nom', 'Note'], ['A, b', 'dit "oui"'], ['C', 'ligne\nsuivante']])
    expect(parseCsv('a;b\n1;2\n')).toEqual([['a', 'b'], ['1', '2']])
    expect(parseCellText('number', '1 234,5 €')).toBe(1234.5)
    expect(parseCellText('checkbox', 'Oui')).toBe(true)
    expect(parseCellText('multiselect', 'a, b')).toEqual(['a', 'b'])
    expect(parseCellText('relation', 'Projets/A')).toEqual(['[[Projets/A]]'])
  })

  it('colonnes : glisser un en-tete, figer jusqu a une colonne', async () => {
    const { el } = await setup()
    expect(heads(el)).toEqual(['@title', 'status', 'priority'])
    const data = new Map<string, string>()
    el.querySelector('[data-testid="base-th"][data-key="priority"]')!.dispatchEvent(dragEvent('dragstart', data))
    el.querySelector('[data-testid="base-th"][data-key="status"]')!.dispatchEvent(dragEvent('drop', data))
    await tick(100)
    expect(heads(el)).toEqual(['@title', 'priority', 'status'])
    click(el.querySelector('[data-testid="base-th"][data-key="priority"] .base-th-label'))
    click(el.querySelector('[data-testid="base-col-freeze"]'))
    await tick(100)
    expect(el.querySelector('[data-testid="base-th"][data-key="@title"]')!.classList.contains('base-sticky')).toBe(true)
    expect(el.querySelector('[data-testid="base-th"][data-key="priority"]')!.classList.contains('base-sticky-last')).toBe(true)
    expect(el.querySelector('[data-testid="base-th"][data-key="status"]')!.classList.contains('base-sticky')).toBe(false)
    // Retour a la ligne : des lignes plus hautes.
    click(el.querySelector('[data-testid="base-view-settings"]'))
    const wrap = el.querySelector('[data-testid="base-layout-wrap"]') as HTMLInputElement
    wrap.checked = true
    wrap.dispatchEvent(new Event('change'))
    await tick(100)
    expect((el.querySelector('[data-testid="base-row"]') as HTMLElement).style.height).toBe('64px')
  })

  it('selection : modifier, dupliquer et supprimer plusieurs lignes', async () => {
    const { el, w } = await setup()
    const check = (title: string) => {
      const box = Array.from(el.querySelectorAll('[data-testid="base-row"]')).find(r => r.querySelector('[data-testid="base-title"]')?.textContent === title)!.querySelector('[data-testid="base-select"]') as HTMLInputElement
      box.checked = true
      box.dispatchEvent(new Event('change'))
    }
    check('Alpha')
    check('Gamma')
    expect(el.querySelector('[data-testid="base-bulk-count"]')!.textContent).toBe('2 sélectionnées')
    // Tout decocher puis recocher : les cases suivent.
    click(el.querySelector('[data-testid="base-bulk-clear"]'))
    expect(Array.from(el.querySelectorAll('[data-testid="base-select"]')).filter(b => (b as HTMLInputElement).checked)).toHaveLength(0)
    check('Alpha')
    check('Gamma')
    click(el.querySelector('[data-testid="base-bulk-edit"]'))
    const key = el.querySelector('[data-testid="base-bulk-key"]') as HTMLSelectElement
    key.value = 'priority'
    key.dispatchEvent(new Event('change'))
    const input = el.querySelector('[data-testid="base-bulk-slot"] [data-testid="base-editor"]') as HTMLInputElement
    input.value = '9'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await tick(100)
    expect(parseFrontmatter(w.notes[0].text).priority).toBe(9)
    expect(parseFrontmatter(w.notes[2].text).priority).toBe(9)
    expect(parseFrontmatter(w.notes[1].text).priority).toBe(1)
    // Dupliquer : une copie avec le meme texte.
    check('Alpha')
    click(el.querySelector('[data-testid="base-bulk-duplicate"]'))
    await tick(150)
    const copy = w.notes.find(n => n.path === 'Projets/Alpha (copie).md')!
    expect(copy.text).toContain('Corps de la note.')
    expect(el.querySelector('[data-testid="base-bulk"]')!.hasAttribute('hidden')).toBe(true)
    // Supprimer : a la corbeille.
    check('Beta')
    click(el.querySelector('[data-testid="base-bulk-delete"]'))
    await tick(150)
    expect(w.vault.deleteFile).toHaveBeenCalledWith('n2')
    expect(titles(el)).not.toContain('Beta')
  })

  it('clavier et presse-papiers : fleches, coller un tableau, effacer', async () => {
    const { el, w } = await setup()
    const td = cell(el, 'Alpha', 'priority')
    td.focus()
    td.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(cell(el, 'Beta', 'priority'))
    // Coller deux lignes et deux colonnes depuis Beta / status.
    const start = cell(el, 'Beta', 'status')
    start.focus()
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'Annulé\t7\nFait\t8\n' } })
    start.dispatchEvent(paste)
    await tick(100)
    expect(parseFrontmatter(w.notes[1].text)).toEqual({ status: 'Annulé', priority: 7 })
    expect(parseFrontmatter(w.notes[2].text)).toEqual({ status: 'Fait', priority: 8 })
    // Copier une cellule.
    const copy = new Event('copy', { bubbles: true, cancelable: true })
    let copied = ''
    Object.defineProperty(copy, 'clipboardData', { value: { setData: (_: string, v: string) => { copied = v } } })
    cell(el, 'Gamma', 'priority').focus()
    cell(el, 'Gamma', 'priority').dispatchEvent(copy)
    expect(copied).toBe('8')
    // Suppr vide la cellule.
    const g = cell(el, 'Gamma', 'priority')
    g.focus()
    g.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    await tick(100)
    expect(parseFrontmatter(w.notes[2].text).priority).toBeNull()
  })

  it('apercu lateral : proprietes modifiables et debut de la note', async () => {
    const { el, w } = await setup()
    click(cell(el, 'Alpha', '@title').querySelector('[data-testid="base-peek"]'))
    await tick(100)
    const panel = el.querySelector('[data-testid="base-peek-panel"]') as HTMLElement
    expect(panel.hidden).toBe(false)
    expect((panel.querySelector('[data-testid="base-peek-title"]') as HTMLInputElement).value).toBe('Alpha')
    expect(panel.querySelector('[data-testid="base-peek-body"]')!.textContent).toContain('Corps de la note.')
    const value = panel.querySelector('.base-peek-value[data-key="priority"]') as HTMLElement
    value.click()
    const input = value.querySelector('[data-testid="base-editor"]') as HTMLInputElement
    input.value = '5'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await tick(150)
    expect(parseFrontmatter(w.notes[0].text).priority).toBe(5)
    expect(panel.querySelector('.base-peek-value[data-key="priority"]')!.textContent).toBe('5')
    click(panel.querySelector('[data-testid="base-peek-close"]'))
    expect(panel.hidden).toBe(true)
  })

  it('ordre manuel : glisser une ligne avant une autre, sans tri', async () => {
    const { el } = await setup()
    expect(titles(el)).toEqual(['Alpha', 'Beta', 'Gamma'])
    const data = new Map<string, string>()
    const row = (t: string) => Array.from(el.querySelectorAll('[data-testid="base-row"]')).find(r => r.querySelector('[data-testid="base-title"]')?.textContent === t) as HTMLElement
    row('Gamma').querySelector('[data-testid="base-row-grip"]')!.dispatchEvent(dragEvent('dragstart', data))
    row('Alpha').dispatchEvent(dragEvent('drop', data))
    await tick(300)
    expect(titles(el)).toEqual(['Gamma', 'Alpha', 'Beta'])
  })

  it('CSV : exporter la vue, importer des lignes', async () => {
    const { view, w } = await setup()
    const v = view as unknown as { exportCsv(): Promise<string>; importCsv(t: string): Promise<number> }
    expect(await v.exportCsv()).toBe('Nom,status,priority\r\nAlpha,En cours,2\r\nBeta,Fait,1\r\nGamma,Fait,3\r\n')
    expect(await v.importCsv('Titre;status;priority;client\nDelta;Fait;4;Acme\nEpsilon;;;\n')).toBe(2)
    await tick(100)
    expect(parseFrontmatter(w.notes.find(n => n.path === 'Projets/Delta.md')!.text)).toEqual({ status: 'Fait', priority: 4, client: 'Acme' })
    expect(w.notes.find(n => n.path === 'Projets/Epsilon.md')).toBeDefined()
  })
})
