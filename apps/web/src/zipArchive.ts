// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Archive .zip minimale (export du vault, donnees du compte). L'ecriture vit
// dans plugin-api (archive.ts) : l'export des presentations (.pptx) s'en sert
// aussi.
export { createZip, type ZipEntry } from '@savoire/plugin-api'
