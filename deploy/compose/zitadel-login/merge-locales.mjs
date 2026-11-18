// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ajoute les textes de Savoire aux traductions de la page de connexion.
//   node merge-locales.mjs <dossier locales de Savoire> <dossier locales de Zitadel>
// fr et en remplacent aussi des textes d'origine ; les autres langues ne
// recoivent que l'espace « savoire » (en anglais), pour ne pas manquer de cle.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [ours, theirs] = process.argv.slice(2)
const read = path => JSON.parse(readFileSync(path, 'utf8'))

function merge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = merge(target[key] && typeof target[key] === 'object' ? target[key] : {}, value)
    } else {
      target[key] = value
    }
  }
  return target
}

const english = read(join(ours, 'en.json'))
for (const file of readdirSync(theirs).filter(f => f.endsWith('.json'))) {
  const lang = file.replace(/\.json$/, '')
  const path = join(theirs, file)
  let override
  try { override = read(join(ours, file)) } catch { override = { savoire: english.savoire } }
  writeFileSync(path, JSON.stringify(merge(read(path), override), null, 2) + '\n')
  console.log(`traductions ${lang} : textes de Savoire ajoutes`)
}
