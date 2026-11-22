// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Modele d'agent Correcteur (ADR-033) : il n'execute rien, il apporte un
// modele en mode proposition. Fournisseur Mistral.
import { describe, it, expect, vi } from 'vitest'
import { proofreaderPreset } from '@savoire/plugin-agent-proofreader'
import proofreader from '@savoire/plugin-agent-proofreader'
import mistral, { MISTRAL_PROVIDER } from '@savoire/plugin-ai-mistral'

describe('Correcteur', () => {
  it('apporte un modele d agent qui lit et propose, sans jamais ecrire directement', async () => {
    const registerPreset = vi.fn(() => () => {})
    await proofreader.onload({ agents: { registerPreset } } as never)
    expect(registerPreset).toHaveBeenCalledWith(proofreaderPreset)
    expect(proofreaderPreset.permissions).toEqual({ read: 'direct', edit: 'propose' })
    expect(proofreaderPreset.instructions).toContain('edit_note')
  })

  it('le plugin Mistral decrit le service, sans cle ni appel', async () => {
    const registerProvider = vi.fn(() => () => {})
    await mistral.onload({ ai: { registerProvider } } as never)
    expect(registerProvider).toHaveBeenCalledWith(MISTRAL_PROVIDER)
    expect(MISTRAL_PROVIDER).toMatchObject({ protocol: 'openai', requiresKey: true })
  })
})

describe('Relecteur', () => {
  it('un modele d agent en veille : il commente et propose, jamais d ecriture directe', async () => {
    const { reviewerPreset } = await import('@savoire/plugin-agent-proofreader')
    const registerPreset = vi.fn(() => () => {})
    await proofreader.onload({ agents: { registerPreset } } as never)
    expect(registerPreset).toHaveBeenCalledWith(reviewerPreset)
    expect(reviewerPreset.watch).toBeDefined()
    expect(reviewerPreset.permissions).toEqual({ read: 'direct', comment: 'direct', edit: 'propose' })
  })
})
