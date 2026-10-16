// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import {
  sanitizeFileName, uniqueAttachmentPath, resolveLinkPath, linkTargetFor,
  ATTACHMENT_LOCATION, attachmentFolderFor, folderNoteOf, isAttachmentPath, noteFolderOf,
} from '@savoire/platform'

describe('nommage des pieces jointes (comme Obsidian)', () => {
  it('un fichier depose garde son nom, dans attachments/', () => {
    expect(uniqueAttachmentPath('Vacances 2026.jpg', () => false)).toBe('attachments/Vacances 2026.jpg')
  })

  it('collision : suffixe « 1 », « 2 »...', () => {
    const taken = new Set(['attachments/Photo.png', 'attachments/Photo 1.png'])
    expect(uniqueAttachmentPath('Photo.png', p => taken.has(p))).toBe('attachments/Photo 2.png')
    expect(uniqueAttachmentPath('Sans extension', p => p === 'attachments/Sans extension')).toBe('attachments/Sans extension 1')
  })

  it('retire les caracteres qui casseraient un lien ![[...]]', () => {
    expect(sanitizeFileName('a[b]|c#d^e:f/g\\h.png')).toBe('a b c d e f g h.png')
    expect(sanitizeFileName('   ')).toBe('fichier')
    expect(sanitizeFileName('.png')).toBe('fichier.png')
  })
})

describe('resolution d\'un lien par nom', () => {
  const paths = ['attachments/Photo.png', 'notes/Photo.png', 'attachments/Logo.svg', 'a/b/Plan.png']

  it('chemin exact d\'abord', () => {
    expect(resolveLinkPath('notes/Photo.png', paths)).toBe('notes/Photo.png')
  })

  it('nom seul : le fichier qui porte ce nom, le chemin le plus court en cas de doublon', () => {
    expect(resolveLinkPath('Logo.svg', paths)).toBe('attachments/Logo.svg')
    expect(resolveLinkPath('Photo.png', paths)).toBe('notes/Photo.png')
  })

  it('fin de chemin', () => {
    expect(resolveLinkPath('b/Plan.png', paths)).toBe('a/b/Plan.png')
    expect(resolveLinkPath('Inconnu.png', paths)).toBeUndefined()
  })

  it('le lien insere est le nom s\'il est unique, sinon le chemin', () => {
    expect(linkTargetFor('attachments/Logo.svg', paths)).toBe('Logo.svg')
    expect(linkTargetFor('attachments/Photo.png', paths)).toBe('attachments/Photo.png')
  })
})

describe('images rangees avec leur note', () => {
  it('le dossier d\'une note porte son nom, a cote d\'elle', () => {
    expect(noteFolderOf('Dossier/Ma note.md')).toBe('Dossier/Ma note/')
    expect(noteFolderOf('Ma note.md')).toBe('Ma note/')
    expect(noteFolderOf('Sans extension')).toBe('')
  })

  it('par defaut, une image envoyee depuis une note va dans le dossier de la note', () => {
    expect(ATTACHMENT_LOCATION).toBe('note-folder')
    expect(attachmentFolderFor('Dossier/Ma note.md')).toBe('Dossier/Ma note/')
    expect(attachmentFolderFor(undefined)).toBe('attachments/')
    expect(attachmentFolderFor('Dossier/Ma note.md', 'attachments')).toBe('attachments/')
  })

  it('uniqueAttachmentPath range dans le dossier demande', () => {
    expect(uniqueAttachmentPath('Photo.png', p => p === 'A/Photo.png', 'A/')).toBe('A/Photo 1.png')
  })

  it('la note d\'un dossier suit la regle de l\'arborescence (.page, puis .md)', () => {
    expect(folderNoteOf('A/Projet/', ['A/Projet.md', 'A/Projet.page', 'A/Projet/x.png'])).toBe('A/Projet.page')
    expect(folderNoteOf('A/Projet/', ['A/Projet.md'])).toBe('A/Projet.md')
    expect(folderNoteOf('attachments/', ['attachments/x.png'])).toBeUndefined()
  })

  it('une piece jointe se reconnait a son extension d\'image', () => {
    expect(isAttachmentPath('Note/Photo.PNG')).toBe(true)
    expect(isAttachmentPath('Note.md')).toBe(false)
  })
})
