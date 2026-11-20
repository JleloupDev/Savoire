// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Auteurs distants d'une note : un agent IA est garde a part de la personne
// pour qui il ecrit (l'historique affiche « Nom (IA), pour Personne »).
import { describe, it, expect } from 'vitest'
import { noteRemoteEditor, takeRemoteEditors } from '@savoire/infrastructure-sync'

describe('noteRemoteEditor', () => {
  it('garde l agent et la personne separes', () => {
    noteRemoteEditor('d', { id: 'bob', name: 'Bob', guest: false })
    noteRemoteEditor('d', { id: 'bob', name: 'Bob', guest: false, agentId: 'a1', agentName: 'Relectrice' })
    const e = takeRemoteEditors('d')
    expect(e).toHaveLength(2)
    expect(e.find(x => x.agentName)).toMatchObject({ id: 'agent:a1:bob', name: 'Bob', agentName: 'Relectrice', guest: false })
    expect(takeRemoteEditors('d')).toEqual([])
  })
})
