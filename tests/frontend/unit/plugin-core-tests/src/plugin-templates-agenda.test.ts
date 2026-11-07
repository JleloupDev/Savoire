// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Plugins core « Modeles » et « Agenda » : variables des modeles, dossier des
// modeles, notes du jour.
import { describe, it, expect } from 'vitest'
import { formatDate, renderTemplate, templateFolderOf } from '@savoire/plugin-api'
import { templatePaths } from '@savoire/plugin-templates'
import { dailyNotes, dailyNotePath, dailyTemplatePath, monthGrid } from '@savoire/plugin-agenda'

const D = new Date(2026, 10, 7, 9, 5, 3)

describe('modeles', () => {
  it('remplace title, date et time, avec ou sans format', () => {
    expect(renderTemplate('# {{title}}\n{{date}} {{time}}', { title: 'Réunion', date: D })).toBe('# Réunion\n2026-11-07 09:05')
    expect(renderTemplate('{{date:dddd D MMMM YYYY}}', { title: '', date: D })).toBe('samedi 7 novembre 2026')
    expect(renderTemplate('{{date:[Semaine] WW}} {{time:HH:mm:ss}}', { title: '', date: D })).toBe('Semaine 45 09:05:03')
    expect(renderTemplate('{{inconnu}} {{ title }}', { title: 'A', date: D })).toBe('{{inconnu}} A')
  })

  it('formats courants', () => {
    expect(formatDate(D, 'DD/MM/YY')).toBe('07/11/26')
    expect(formatDate(new Date(2027, 0, 1), 'W')).toBe('53')
  })

  it('trouve le dossier des modeles, francais ou Obsidian', () => {
    expect(templateFolderOf(['Notes/a.md', 'Modèles/Réunion.md'])).toBe('Modèles/')
    expect(templateFolderOf(['Templates/Daily.md'])).toBe('Templates/')
    expect(templateFolderOf(['Notes/a.md'])).toBeNull()
    expect(templatePaths(['Modèles/b.md', 'Modèles/a.md', 'Modèles/img.png', 'x.md'])).toEqual(['Modèles/a.md', 'Modèles/b.md'])
  })
})

describe('notes du jour', () => {
  const files = ['Journal/2026-11-06.md', '2026-11-05.md', 'Archives/2026-11-06.md', 'Modèles/Note du jour.md', 'Notes/2026 bilan.md']

  it('reconnait les notes du jour a leur nom, Journal/ d\'abord', () => {
    const days = dailyNotes(files)
    expect([...days.keys()].sort()).toEqual(['2026-11-05', '2026-11-06'])
    expect(days.get('2026-11-06')).toBe('Journal/2026-11-06.md')
  })

  it('une note existante est reprise, sinon une neuve dans Journal/', () => {
    expect(dailyNotePath('2026-11-05', files)).toBe('2026-11-05.md')
    expect(dailyNotePath('2026-11-07', files)).toBe('Journal/2026-11-07.md')
  })

  it('le modele « Note du jour »', () => {
    expect(dailyTemplatePath(files)).toBe('Modèles/Note du jour.md')
    expect(dailyTemplatePath(['Templates/Daily.md'])).toBe('Templates/Daily.md')
    expect(dailyTemplatePath(['Modèles/Autre.md'])).toBeNull()
  })

  it('le mois en semaines entieres, du lundi au dimanche', () => {
    const grid = monthGrid(2026, 10)
    expect(grid.length % 7).toBe(0)
    expect(grid[0].getDay()).toBe(1)
    expect(grid[0].getDate()).toBe(26)
    expect(grid.at(-1)!.getDay()).toBe(0)
  })
})
