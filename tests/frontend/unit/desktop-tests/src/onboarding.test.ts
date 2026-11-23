// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Accueil de la premiere visite : origine (Obsidian, Notion), type de fichier
// par defaut, pose dans la disposition.
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Modules relus a neuf : ils lisent localStorage au chargement. */
async function load() {
  vi.resetModules()
  const layout = await import('../../../../../apps/web/src/layoutPreferences')
  const onboarding = await import('../../../../../apps/web/src/onboardingPreferences')
  return { layout, onboarding }
}

beforeEach(() => { localStorage.clear() })

describe('accueil et type de fichier par defaut', () => {
  it('premiere visite : accueil a faire, notes Markdown par defaut', async () => {
    const { layout, onboarding } = await load()
    expect(onboarding.needsOnboarding()).toBe(true)
    expect(layout.defaultFileType()).toBe('md')
  })

  it('Notion confirme : la vue Notion et les pages, accueil fini', async () => {
    const { layout, onboarding } = await load()
    onboarding.applyOnboarding('notion', 'page')
    expect(layout.layoutPreferences().presetId).toBe('notion')
    expect(layout.defaultFileType()).toBe('page')
    expect(layout.isLayoutModified()).toBe(false)
    expect(layout.layoutPreferences().config.hidden).toEqual(expect.arrayContaining(['backlinks', 'review', 'history']))
    expect(onboarding.needsOnboarding()).toBe(false)
    // Garde au rechargement.
    const again = await load()
    expect(again.layout.defaultFileType()).toBe('page')
    expect(again.onboarding.needsOnboarding()).toBe(false)
  })

  it('Obsidian sans le Markdown : la vue Obsidian, les pages, vue marquee modifiee', async () => {
    const { layout, onboarding } = await load()
    onboarding.applyOnboarding('obsidian', 'page')
    expect(layout.layoutPreferences().presetId).toBe('obsidian')
    expect(layout.defaultFileType()).toBe('page')
    expect(layout.isLayoutModified()).toBe(true)
  })

  it('passer : rien ne change, l\'accueil ne revient pas', async () => {
    const { layout, onboarding } = await load()
    onboarding.markOnboardingDone()
    expect(layout.layoutPreferences().presetId).toBe('savoire')
    expect((await load()).onboarding.needsOnboarding()).toBe(false)
  })

  it('disposition deja reglee (avant l\'accueil) : pas d\'accueil, le type de la vue', async () => {
    localStorage.setItem('savoire-layout', JSON.stringify({ v: 2, presetId: 'notion', config: { hidden: [], leftOpen: 'explorer', rightOpen: false, rightFocus: null } }))
    const { layout, onboarding } = await load()
    expect(onboarding.needsOnboarding()).toBe(false)
    expect(layout.defaultFileType()).toBe('page')
  })

  it('le type par defaut se change dans la disposition', async () => {
    const { layout } = await load()
    layout.updateLayoutConfig({ defaultFileType: 'page' })
    expect(layout.defaultFileType()).toBe('page')
    expect(layout.isLayoutModified()).toBe(true)
    layout.selectLayoutPreset('savoire')
    expect(layout.defaultFileType()).toBe('md')
  })

  it('vue Notion d\'avant : les retroliens partent une fois, puis restent au choix', async () => {
    localStorage.setItem('savoire-layout', JSON.stringify({ v: 2, presetId: 'notion', config: { hidden: ['notes-tools'], leftOpen: 'explorer', rightOpen: false, rightFocus: null } }))
    const { layout } = await load()
    expect(layout.layoutPreferences().config.hidden).toEqual(expect.arrayContaining(['backlinks', 'review', 'history']))
    layout.setPanelVisible('backlinks', true)
    const again = await load()
    expect(again.layout.layoutPreferences().config.hidden).not.toContain('backlinks')
  })

  it('les autres vues gardent leurs retroliens', async () => {
    localStorage.setItem('savoire-layout', JSON.stringify({ v: 2, presetId: 'obsidian', config: { hidden: ['review'], leftOpen: 'explorer', rightOpen: true, rightFocus: 'backlinks' } }))
    const { layout } = await load()
    expect(layout.layoutPreferences().config.hidden).not.toContain('backlinks')
  })

  it('vue Notion en version 3 : revision et versions partent une fois', async () => {
    localStorage.setItem('savoire-layout', JSON.stringify({ v: 3, presetId: 'notion', config: { hidden: ['notes-tools'], leftOpen: 'explorer', rightOpen: false, rightFocus: null } }))
    const { layout } = await load()
    const hidden = layout.layoutPreferences().config.hidden
    expect(hidden).toEqual(expect.arrayContaining(['review', 'history']))
    expect(hidden).not.toContain('backlinks')
  })
})
