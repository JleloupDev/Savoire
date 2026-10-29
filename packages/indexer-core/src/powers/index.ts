// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les pouvoirs de la premiere version. Un nouveau pouvoir (texte des pieces
// jointes, recherche semantique, rappels...) = un module de plus ici, et une
// ligne dans docs/Architecture/indexer-protocol.md.
import type { IndexPower } from '../power'
import { linksPower } from './links'
import { queryPower } from './query'
import { searchPower } from './search'
import { statusPower } from './status'
import { tagsPower } from './tags'

export function defaultPowers(): IndexPower[] {
  return [queryPower, searchPower, linksPower, tagsPower, statusPower]
}

export { queryPower, searchPower, linksPower, tagsPower, statusPower }
