// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Animations (.anim) : le format (scene, styles, images cles, code), le
// document isole joue par anime.js, l'integration ![[x.anim]], les
// commentaires au timecode et les outils d'agent (MCP).
import { describe, it, expect, vi } from 'vitest'
import type { PluginAPI, ReviewAnnotation, ToolContext } from '@savoire/plugin-api'
import { TEXT_PROPOSAL, slideDeck } from '@savoire/plugin-api'
import {
  ANIM_CSP, ANIM_TEMPLATE, animEmbedText, animationAgentTools, animationParts, buildSrcdoc, checkKeyframes, composeAnimation,
  createAnimationPlugin, describeTarget, formatTimecode, parseAnimEmbed, parseTimecode, replaceParts, timecodeThreads,
} from '@savoire/plugin-animation'

describe('format .anim', () => {
  it('compose et relit les parties', () => {
    const src = composeAnimation({ css: '.a { color: red }', html: '<div class="a">A</div>', keyframes: { tracks: [{ target: '.a', x: 10 }] }, script: 'timeline.add(".a", { y: 5 })' })
    const p = animationParts(src)
    expect(p.css).toBe('.a { color: red }')
    expect(p.html).toBe('<div class="a">A</div>')
    expect(p.keyframes).toEqual({ tracks: [{ target: '.a', x: 10 }] })
    expect(p.script).toBe('timeline.add(".a", { y: 5 })')
    // Remplacer une partie garde les autres.
    const next = animationParts(replaceParts(src, { script: 'timeline.add(".a", { x: 1 })' }))
    expect(next.css).toBe('.a { color: red }')
    expect(next.script).toBe('timeline.add(".a", { x: 1 })')
    expect(animationParts(ANIM_TEMPLATE).html).toContain('class="balle"')
  })

  it('verifie les images cles', () => {
    expect(checkKeyframes(null)).toBeNull()
    expect(checkKeyframes({ tracks: [{ target: '.a' }] })).toBeNull()
    expect(checkKeyframes({ tracks: [{ x: 1 }] })).toMatch(/target/)
    expect(checkKeyframes([1])).toMatch(/objet/)
  })

  it('lit et ecrit les timecodes', () => {
    expect(formatTimecode(1250)).toBe('0:01.25')
    expect(formatTimecode(61000)).toBe('1:01.00')
    expect(parseTimecode('0:01.25')).toBe(1250)
    expect(parseTimecode('1.5')).toBe(1500)
    expect(parseTimecode('800ms')).toBe(800)
    expect(parseTimecode('n’importe')).toBeNull()
  })

  it('lit les options d une integration', () => {
    expect(parseAnimEmbed('![[Intro.anim]]')).toEqual({ name: 'Intro.anim', loop: false, autoplay: true, controls: true })
    expect(parseAnimEmbed('![[Dossier/Intro.anim|boucle sans-barre]]')).toEqual({ name: 'Dossier/Intro.anim', loop: true, autoplay: true, controls: false })
    expect(parseAnimEmbed('![[Intro.anim|pause]]')?.autoplay).toBe(false)
    expect(parseAnimEmbed('![[Intro.board]]')).toBeNull()
    expect(animEmbedText('Intro.anim', { loop: true, controls: false })).toBe('![[Intro.anim|boucle sans-barre]]')
  })
})

describe('document de l animation', () => {
  it('isole le code : CSP sans reseau, anime.js ecrit, le code ne ferme pas sa balise', () => {
    const src = composeAnimation({ html: '<div id="x"></div>', script: 'const s = "</script><img src=x>"' })
    const doc = buildSrcdoc(src, { channel: 'c1', anime: 'window.anime={createTimeline(){}}', theme: '' })
    expect(doc).toContain(`content="${ANIM_CSP}"`)
    expect(ANIM_CSP).toContain("default-src 'none'")
    expect(ANIM_CSP).not.toMatch(/connect-src|https?:/)
    expect(doc).toContain('window.anime={createTimeline(){}}')
    expect(doc).toContain('const s = "<\\/script><img src=x>"')
    expect(animationParts(src).script).toBe('const s = "<\\/script><img src=x>"')
    // La scene avant les images cles, le code apres.
    expect(doc.indexOf('<div id="x">')).toBeLessThan(doc.indexOf('__savoireTracks(window.keyframes)'))
    expect(doc.indexOf('__savoireTracks(window.keyframes)')).toBeLessThan(doc.indexOf('const s ='))
  })
})

describe('commentaires au timecode', () => {
  const a = (id: string, target: unknown, status: ReviewAnnotation['status'] = 'open'): ReviewAnnotation => ({
    id, docId: 'd', kind: 'comment', text: id, authorName: 'Jean', byAgent: false, createdAt: '', status, target, replies: [],
  })

  it('range les fils dans l ordre du temps, a part ceux de toute l animation', () => {
    const { timed, other } = timecodeThreads([
      a('b', { kind: 'anim.time', start: 2000 }),
      a('a', { kind: 'anim.time', start: 500, end: 900, element: '.balle', elementLabel: 'div.balle' }),
      a('tout', undefined),
      a('autre', { at: 3, quote: 'x' }),
    ])
    expect(timed.map(t => t.id)).toEqual(['a', 'b'])
    expect(other.map(t => t.id)).toEqual(['tout'])
    expect(describeTarget(timed[0]!.target)).toBe('De 0:00.50 à 0:00.90 · div.balle')
    expect(describeTarget(timed[1]!.target)).toBe('À 0:02.00')
  })
})

describe('outils d agent', () => {
  const actor = { agentId: 'a', agentName: 'Animateur', onBehalfOf: { userId: 'u', displayName: 'Jean' } }
  const ctx = (mode: 'direct' | 'propose' = 'direct') => ({ mode, actor } as unknown as ToolContext)

  function setup() {
    const files = new Map<string, { id: string; text: string }>([
      ['Cours.md', { id: 'n1', text: '---\ntype: slides\n---\n# Cours\n\n---\n\n## Partie 1\n\nTexte\n\nNotes : rappel\n' }],
      ['Intro.anim', { id: 'a1', text: composeAnimation({ html: '<div class="a"></div>', script: 'timeline.add(".a", { x: 10 })' }) }],
    ])
    const byId = () => new Map([...files].map(([path, f]) => [f.id, { path, ...f }]))
    const propose = vi.fn(async () => 'p1')
    let next = 1
    const api = {
      vault: {
        getFileTree: () => [...files].map(([path, f]) => ({ docId: f.id, path })),
        resolveDocumentId: (p: string) => files.get(p)?.id,
        read: async (id: string) => byId().get(id)!.text,
        editText: async (id: string, edit: (s: string) => string) => { const f = byId().get(id)!; files.get(f.path)!.text = edit(f.text); return true },
        createFile: async (p: string) => { files.set(p, { id: `new${next++}`, text: '' }) },
        createFolder: async () => {},
      },
      review: { propose },
    } as unknown as PluginAPI
    const tools = Object.fromEntries(animationAgentTools(api).map(t => [t.spec.name, t]))
    return { files, tools, propose }
  }

  it('declare des outils pour le serveur (MCP) aussi', () => {
    const { tools } = setup()
    expect(Object.keys(tools)).toEqual(['animation_list', 'animation_read', 'animation_create', 'animation_update', 'animation_embed'])
    for (const t of Object.values(tools)) expect(t.spec.runtimes).toEqual(['app', 'server'])
  })

  it('cree une animation a partir de ses parties', async () => {
    const { files, tools } = setup()
    const r = await tools.animation_create!.run({ path: 'Anims/Logo', html: '<svg></svg>', script: 'timeline.add("svg", { rotate: 90 })', keyframes: { tracks: [{ target: 'svg', scale: 2 }] } }, ctx())
    expect(r.text).toContain('Anims/Logo.anim')
    const p = animationParts(files.get('Anims/Logo.anim')!.text)
    expect(p.html).toBe('<svg></svg>')
    expect(p.keyframes).toEqual({ tracks: [{ target: 'svg', scale: 2 }] })
    await expect(tools.animation_create!.run({ path: 'Intro', html: 'x' }, ctx())).rejects.toThrow(/existe déjà/)
    await expect(tools.animation_create!.run({ path: 'X', keyframes: { tracks: [{}] } }, ctx())).rejects.toThrow(/target/)
    await expect(tools.animation_create!.run({ path: 'Y', html: 'x' }, ctx('propose'))).rejects.toThrow(/proposition/)
  })

  it('modifie une partie, un passage, ou propose la modification', async () => {
    const { files, tools, propose } = setup()
    await tools.animation_update!.run({ path: 'Intro.anim', css: '.a { width: 10px }' }, ctx())
    expect(animationParts(files.get('Intro.anim')!.text).css).toBe('.a { width: 10px }')
    expect(animationParts(files.get('Intro.anim')!.text).script).toContain('x: 10')
    await tools.animation_update!.run({ path: 'Intro', find: 'x: 10', replace: 'x: 99' }, ctx())
    expect(files.get('Intro.anim')!.text).toContain('x: 99')
    await expect(tools.animation_update!.run({ path: 'Intro', find: 'absent', replace: 'y' }, ctx())).rejects.toThrow(/introuvable/)
    const before = files.get('Intro.anim')!.text
    const r = await tools.animation_update!.run({ path: 'Intro', script: 'timeline.add(".a", { y: 1 })' }, ctx('propose'))
    expect(r.text).toMatch(/proposée/)
    expect(files.get('Intro.anim')!.text).toBe(before)
    expect(propose).toHaveBeenCalledWith('a1', TEXT_PROPOSAL, expect.anything(), expect.stringContaining('Animateur'))
  })

  it('integre dans une diapositive, avant ses notes', async () => {
    const { files, tools } = setup()
    const r = await tools.animation_embed!.run({ note: 'Cours', animation: 'Intro', slide: 2, loop: true }, ctx())
    expect(r.text).toContain('diapositive 2')
    const deck = slideDeck(files.get('Cours.md')!.text)
    expect(deck.slides[1]!.markdown.endsWith('![[Intro.anim|boucle]]')).toBe(true)
    expect(deck.slides[1]!.notes).toBe('rappel')
    await expect(tools.animation_embed!.run({ note: 'Cours', animation: 'Intro', slide: 5 }, ctx())).rejects.toThrow(/2 diapositive/)
  })
})

describe('plugin', () => {
  it('declare le type .anim et le bloc ![[x.anim]]', async () => {
    const files: string[] = []
    const blocks: string[] = []
    const plugin = createAnimationPlugin()
    await plugin.onload({
      files: { register: (s: { extension: string }) => files.push(s.extension), unregister: () => {} },
      blocks: { register: (s: { type: string }) => blocks.push(s.type), unregister: () => {} },
      vault: { getFileTree: () => [], resolveDocumentId: () => undefined },
    } as unknown as PluginAPI)
    expect(files).toEqual(['anim'])
    expect(blocks).toEqual(['anim-embed'])
    expect(plugin.manifest.permissions).toContain('agents')
  })
})
