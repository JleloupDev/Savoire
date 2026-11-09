// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le lecteur d'archives .zip vit dans plugin-api (les extracteurs des plugins
// s'en servent aussi). Re-exporte ici pour l'import Notion.
export { readZip, ZipFormatError, type ArchiveFile } from '@savoire/plugin-api'
