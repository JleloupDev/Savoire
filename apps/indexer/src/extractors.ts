// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les extracteurs que le pair indexeur fait tourner : seulement ceux des
// plugins proposes et verifies par l'equipe Savoire (manifeste « official »).
// Le code d'un plugin tiers ne tourne jamais ici : il tourne sur le poste de
// la personne (appli de bureau), ou sur un pair indexeur heberge par le
// client lui-meme.
import { extensionOfPath, type ExtractorSpec, type VaultPlugin } from '@savoire/plugin-api'
import word, { EXTRACTOR as WORD } from '@savoire/plugin-word'
import powerpoint, { EXTRACTOR as POWERPOINT } from '@savoire/plugin-powerpoint'
import excel, { EXTRACTOR as EXCEL } from '@savoire/plugin-excel'
import opendocument, { EXTRACTOR as OPENDOCUMENT } from '@savoire/plugin-opendocument'
import pdf, { EXTRACTOR as PDF } from '@savoire/plugin-pdf'
import images, { EXTRACTOR as IMAGES, configureOcr } from '@savoire/plugin-images'
import webpage, { EXTRACTOR as WEBPAGE } from '@savoire/plugin-webpage'
import csv, { EXTRACTOR as CSV } from '@savoire/plugin-csv'

const OFFICIAL: [VaultPlugin, ExtractorSpec][] = [
  [word, WORD], [powerpoint, POWERPOINT], [excel, EXCEL], [opendocument, OPENDOCUMENT],
  [pdf, PDF], [images, IMAGES], [webpage, WEBPAGE], [csv, CSV],
]

export interface ExtractorOptions {
  /** OCR des images (lent : quelques secondes par image). */
  ocr: boolean
  /** Dossier du cache de l'OCR (langues telechargees une fois). */
  cacheDir: string
}

/** Les extracteurs officiels, par extension. Un plugin non verifie est refuse. */
export function officialExtractors(opts: ExtractorOptions): (path: string) => ExtractorSpec | undefined {
  configureOcr({ enabled: opts.ocr, cachePath: opts.cacheDir })
  const byExt = new Map<string, ExtractorSpec>()
  for (const [plugin, spec] of OFFICIAL) {
    if (!plugin.manifest.official) throw new Error(`plugin non verifie refuse sur le serveur : ${plugin.manifest.id}`)
    for (const ext of spec.extensions) byExt.set(ext, spec)
  }
  return path => byExt.get(extensionOfPath(path))
}
