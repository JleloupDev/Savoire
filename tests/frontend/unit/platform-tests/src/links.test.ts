// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import { resolveLinkPath, linkTargetFor, fileExtensionOf, withNoteExtension } from '@savoire/plugin-api'

describe('liens par nom de note, comme Obsidian', () => {
  const paths = [
    'Bible/01 - Genèse/Genèse 2.md',
    'Bible/02 - Exode/Exode 1.md',
    'Notes/Projet.md',
    'Archives/Projet.md',
    'Archives/vieux/Projet.md',
    'Notes/Ps. 23.md',
    'Notes/Clifyang a gagné. Mais il.md',
    'medias/Projet.png',
  ]

  it('le nom seul, sans dossier ni .md', () => {
    expect(resolveLinkPath('Genèse 2', paths)).toBe('Bible/01 - Genèse/Genèse 2.md')
    expect(resolveLinkPath('Genèse 2.md', paths)).toBe('Bible/01 - Genèse/Genèse 2.md')
  })

  it('casse ignoree', () => expect(resolveLinkPath('exode 1', paths)).toBe('Bible/02 - Exode/Exode 1.md'))

  it('un point dans le nom n\'est pas une extension', () => {
    expect(resolveLinkPath('Ps. 23', paths)).toBe('Notes/Ps. 23.md')
    expect(resolveLinkPath('Clifyang a gagné. Mais il', paths)).toBe('Notes/Clifyang a gagné. Mais il.md')
  })

  it('nom ambigu : la note avant l\'image, puis le chemin le plus court', () => {
    expect(resolveLinkPath('Projet', paths)).toBe('Notes/Projet.md')
  })

  it('le chemin leve l\'ambiguite, entier ou par la fin', () => {
    expect(resolveLinkPath('Archives/Projet', paths)).toBe('Archives/Projet.md')
    expect(resolveLinkPath('vieux/Projet', paths)).toBe('Archives/vieux/Projet.md')
  })

  it('inconnu : rien', () => expect(resolveLinkPath('Lévitique 1', paths)).toBeUndefined())

  it('lien insere : le nom si unique, sinon le chemin, sans .md', () => {
    expect(linkTargetFor('Bible/01 - Genèse/Genèse 2.md', paths)).toBe('Genèse 2')
    expect(linkTargetFor('Archives/Projet.md', paths)).toBe('Archives/Projet')
    expect(linkTargetFor('Notes/Ps. 23.md', paths)).toBe('Ps. 23')
  })
})

describe('extension d\'un nom de fichier', () => {
  it('reconnait les vraies extensions', () => {
    expect(fileExtensionOf('a/photo.PNG')).toBe('png')
    expect(fileExtensionOf('note.md')).toBe('md')
    expect(fileExtensionOf('video.mp4')).toBe('mp4')
  })
  it('ignore les points du texte', () => {
    expect(fileExtensionOf('Ps. 23')).toBe('')
    expect(fileExtensionOf('Note v1.2')).toBe('')
    expect(fileExtensionOf('il a gagné. Mais il')).toBe('')
    expect(fileExtensionOf('.cache')).toBe('')
  })
  it('ajoute .md a un nom de note', () => {
    expect(withNoteExtension('Ps. 23')).toBe('Ps. 23.md')
    expect(withNoteExtension('dossier/plan.board')).toBe('dossier/plan.board')
  })
})
