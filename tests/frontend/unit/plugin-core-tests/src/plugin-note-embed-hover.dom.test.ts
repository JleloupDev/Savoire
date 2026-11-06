// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, afterEach } from 'vitest'
import { installLinkPreview, previewTargetOf } from '@savoire/plugin-note-embed'
import type { PluginAPI } from '@savoire/plugin-api'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

function setup(delay: number) {
  const calls: { page: string; subpath: unknown }[] = []
  const api = { workspace: { linkPreviewDelay: () => delay } } as unknown as PluginAPI
  const off = installLinkPreview(api, async (body, page, subpath) => {
    calls.push({ page, subpath })
    body.textContent = `contenu de ${page}`
  })
  const editor = document.createElement('div')
  editor.className = 'cm-editor'
  editor.innerHTML = '<p>Voir <a href="#Gen%C3%A8se%201#%5E3">Genèse 1 &gt; ^3</a> et <a href="https://x.fr">web</a></p>'
  document.body.appendChild(editor)
  const link = editor.querySelector('a')!
  return { calls, off, editor, link, web: editor.querySelectorAll('a')[1] }
}

const over = (el: Element) => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
const out = (el: Element, to: Element | null = document.body) => el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: to }))
const preview = () => document.querySelector('[data-testid="link-preview"]')

let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null; document.body.innerHTML = '' })

describe('apercu des liens survoles', () => {
  it('lit la cible : note, titre, bloc', () => {
    expect(previewTargetOf('#Gen%C3%A8se%201#%5E3')).toEqual({ page: 'Genèse 1', subpath: { kind: 'block', id: '3' } })
    expect(previewTargetOf('#Ps. 23#Verset clé')).toEqual({ page: 'Ps. 23', subpath: { kind: 'heading', headings: ['Verset clé'] } })
    expect(previewTargetOf('#Note')).toEqual({ page: 'Note', subpath: null })
    expect(previewTargetOf('https://x.fr')).toBeNull()
  })

  it('apparait apres le delai, avec le bloc vise', async () => {
    const t = setup(30); cleanup = t.off
    over(t.link)
    await wait(10)
    expect(preview()).toBeNull()
    await wait(40)
    expect(preview()?.textContent).toContain('contenu de Genèse 1')
    expect(t.calls).toEqual([{ page: 'Genèse 1', subpath: { kind: 'block', id: '3' } }])
  })

  it('quitter le lien avant le delai : rien ; apres : se ferme', async () => {
    const t = setup(30); cleanup = t.off
    over(t.link); await wait(10); out(t.link)
    await wait(50)
    expect(preview()).toBeNull()
    over(t.link); await wait(50)
    expect(preview()).not.toBeNull()
    out(t.link); await wait(350)
    expect(preview()).toBeNull()
  })

  it('la souris passe dans l\'apercu : il reste ouvert', async () => {
    const t = setup(20); cleanup = t.off
    over(t.link); await wait(40)
    const box = preview()!
    out(t.link, box)
    box.dispatchEvent(new MouseEvent('mouseenter'))
    await wait(350)
    expect(preview()).not.toBeNull()
    box.dispatchEvent(new MouseEvent('mouseleave'))
    await wait(350)
    expect(preview()).toBeNull()
  })

  it('delai 0 : jamais d\'apercu ; lien externe : jamais ; Echap ferme', async () => {
    const t0 = setup(0)
    over(t0.link); await wait(30)
    expect(preview()).toBeNull()
    t0.off(); document.body.innerHTML = ''
    const t = setup(10); cleanup = t.off
    over(t.web); await wait(30)
    expect(preview()).toBeNull()
    over(t.link); await wait(30)
    expect(preview()).not.toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(preview()).toBeNull()
  })
})
