// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-base : dispositions liste, galerie, calendrier, frise, graphique et
// formulaire.
import { describe, it, expect } from 'vitest'
import { parseFrontmatter } from '@savoire/plugin-api'
import { shiftDate, monthGrid } from '@savoire/plugin-base'
import { click, mount, tick, world } from './baseHarness'

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const today = new Date()
const day = (n: number) => iso(new Date(today.getFullYear(), today.getMonth(), n))

const NOTES = [
  { path: 'Projets/Alpha.md', text: `---\netat: Fait\nprix: 10\nquand: ${day(3)}\nimage: "[[alpha.png]]"\n---\n` },
  { path: 'Projets/Beta.md', text: `---\netat: En cours\nprix: 5\nquand: ${day(10)}/${day(12)}\n---\n` },
  { path: 'Projets/Gamma.md', text: `---\netat: Fait\nprix: 7\n---\n` },
]

const rel = (n: number) => iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + n))

async function setup(notes = NOTES) {
  const w = world(notes)
  const a = w.member(0)
  a.types.set({ key: 'etat', type: 'select', options: [{ value: 'Fait', color: 'green' }, { value: 'En cours', color: 'blue' }] })
  a.types.set({ key: 'prix', type: 'number' })
  a.types.set({ key: 'quand', type: 'date' })
  a.types.set({ key: 'image', type: 'files' })
  ;(w.vault as unknown as { resolveAttachmentUrl: (p: string) => Promise<string> }).resolveAttachmentUrl = async p => `blob:${p}`
  const m = await mount(w, 0, a.api)
  await tick(150)
  return { w, a, ...m }
}

describe('dispositions', () => {
  it('dates : decalage et grille du mois', () => {
    expect(shiftDate('2026-11-24', 3)).toBe('2026-11-27')
    expect(shiftDate('2026-11-30T10:00', 2)).toBe('2026-12-02T10:00')
    expect(shiftDate('2026-11-24/2026-11-26', -1)).toBe('2026-11-23/2026-11-25')
    const g = monthGrid(new Date(2026, 10, 1))
    expect(iso(g.start)).toBe('2026-10-26')
    expect(iso(g.end)).toBe('2026-12-07')
  })

  it('liste et galerie : les pages, leurs proprietes, une couverture', async () => {
    const { el } = await setup()
    click(el.querySelector('[data-testid="base-type-list"]'))
    await tick(150)
    const items = Array.from(el.querySelectorAll('[data-testid="base-list-item"] [data-testid="base-item-title"]')).map(t => t.textContent)
    expect(items).toEqual(['Alpha', 'Beta', 'Gamma'])
    click(el.querySelector('[data-testid="base-type-gallery"]'))
    await tick(150)
    // La galerie prend la premiere propriete Fichiers pour couverture.
    const cards = el.querySelectorAll('[data-testid="base-gallery-card"]')
    expect(cards).toHaveLength(3)
    await tick(50)
    expect((cards[0].querySelector('[data-testid="base-cover"]') as HTMLImageElement).src).toBe('blob:alpha.png')
    expect(cards[1].querySelector('[data-testid="base-cover"]')).toBeNull()
  })

  it('calendrier : jour et periode, glisser deplace la date, + cree une page', async () => {
    const { el, w } = await setup()
    click(el.querySelector('[data-testid="base-type-calendar"]'))
    await tick(200)
    const chips = (d: string) => Array.from(el.querySelectorAll(`[data-testid="base-cal-day"][data-day="${d}"] [data-testid="base-cal-chip"]`)).map(c => c.textContent)
    expect(chips(day(3))).toEqual(['Alpha'])
    expect(chips(day(10))).toEqual(['Beta'])
    expect(chips(day(11))).toEqual(['Beta'])
    expect(chips(day(12))).toEqual(['Beta'])
    // Glisser Alpha du 3 au 5.
    const drop = el.querySelector(`[data-testid="base-cal-day"][data-day="${day(5)}"]`) as HTMLElement
    const data = new Map<string, string>()
    const dt = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '', effectAllowed: '' }
    const chip = el.querySelector(`[data-testid="base-cal-day"][data-day="${day(3)}"] [data-testid="base-cal-chip"]`) as HTMLElement
    const ev = (type: string) => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(e, 'dataTransfer', { value: dt }); return e }
    chip.dispatchEvent(ev('dragstart'))
    drop.dispatchEvent(ev('drop'))
    await tick(150)
    expect(parseFrontmatter(w.notes[0].text).quand).toBe(day(5))
    // Une periode glissee garde sa duree.
    const beta = el.querySelector(`[data-testid="base-cal-day"][data-day="${day(11)}"] [data-testid="base-cal-chip"]`) as HTMLElement
    beta.dispatchEvent(ev('dragstart'))
    ;(el.querySelector(`[data-testid="base-cal-day"][data-day="${day(13)}"]`) as HTMLElement).dispatchEvent(ev('drop'))
    await tick(150)
    expect(parseFrontmatter(w.notes[1].text).quand).toBe(`${day(12)}/${day(14)}`)
    // + sur un jour.
    click(el.querySelector(`[data-testid="base-cal-day"][data-day="${day(20)}"] [data-testid="base-cal-add"]`))
    await tick(150)
    const page = w.notes.find(n => n.path === 'Projets/Sans titre.md')!
    expect(parseFrontmatter(page.text).quand).toBe(day(20))
  })

  it('frise : une barre par ligne datee, deplacer et allonger', async () => {
    const { el, w } = await setup([
      { path: 'Projets/Alpha.md', text: `---\nquand: ${rel(1)}\n---\n` },
      { path: 'Projets/Beta.md', text: `---\nquand: ${rel(3)}/${rel(5)}\n---\n` },
      { path: 'Projets/Gamma.md', text: '---\nprix: 1\n---\n' },
    ])
    click(el.querySelector('[data-testid="base-type-timeline"]'))
    await tick(200)
    const bars = Array.from(el.querySelectorAll('[data-testid="base-tl-bar"]')) as HTMLElement[]
    expect(bars.map(b => b.textContent)).toEqual(['Alpha', 'Beta'])
    // Beta dure trois jours : sa barre est trois fois plus large qu'Alpha.
    expect(parseFloat(bars[1].style.width)).toBe(parseFloat(bars[0].style.width) * 3)
    const bar = bars[0]
    bar.dispatchEvent(new MouseEvent('mousedown', { clientX: 100 }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 + 36 * 2 }))
    window.dispatchEvent(new MouseEvent('mouseup'))
    await tick(150)
    expect(parseFrontmatter(w.notes[0].text).quand).toBe(rel(3))
    const grip = (el.querySelectorAll('[data-testid="base-tl-bar"]')[1] as HTMLElement).querySelector('.base-tl-grip') as HTMLElement
    grip.dispatchEvent(new MouseEvent('mousedown', { clientX: 300 }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 300 + 36 }))
    window.dispatchEvent(new MouseEvent('mouseup'))
    await tick(150)
    expect(parseFrontmatter(w.notes[1].text).quand).toBe(`${rel(3)}/${rel(6)}`)
  })

  it('graphique : nombre de lignes par etat, puis somme des prix', async () => {
    const { el } = await setup()
    click(el.querySelector('[data-testid="base-type-chart"]'))
    await tick(200)
    const legend = () => Array.from(el.querySelectorAll('[data-testid="base-chart-item"]')).map(i => i.textContent)
    expect(legend()).toEqual(['Fait : 2', 'En cours : 1'])
    click(el.querySelector('[data-testid="base-view-settings"]'))
    const y = el.querySelector('[data-testid="base-layout-y"]') as HTMLSelectElement
    y.value = 'prix'
    y.dispatchEvent(new Event('change'))
    await tick(300)
    expect(legend()).toEqual(['Fait : 17', 'En cours : 5'])
    expect(el.querySelectorAll('[data-testid="base-chart-mark"]')).toHaveLength(2)
  })

  it('formulaire : un champ par colonne, envoyer cree une page', async () => {
    const { el, w } = await setup()
    click(el.querySelector('[data-testid="base-type-form"]'))
    await tick(150)
    const fields = Array.from(el.querySelectorAll('[data-testid="base-form-field"]')).map(f => (f as HTMLElement).dataset.key)
    expect(fields).toEqual(['@title', 'etat', 'prix', 'quand', 'image'])
    const field = (k: string) => el.querySelector(`[data-testid="base-form-field"][data-key="${k}"] .base-input, [data-testid="base-form-field"][data-key="${k}"] textarea`) as HTMLInputElement
    field('@title').value = 'Delta'
    const etat = el.querySelector('[data-testid="base-form-field"][data-key="etat"] select') as HTMLSelectElement
    etat.value = 'En cours'
    field('prix').value = '12'
    ;(el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }))
    await tick(200)
    const page = w.notes.find(n => n.path === 'Projets/Delta.md')!
    expect(parseFrontmatter(page.text)).toEqual({ etat: 'En cours', prix: 12 })
    expect(el.querySelector('[data-testid="base-form-status"]')!.textContent).toBe('Envoyé, merci.')
  })
})
