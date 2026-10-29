// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La recherche plein texte SQL (pouvoir search, FTS5) passe le contrat commun.
import { describeSearchEngineContract } from '../../plugin-runtime-tests/src/contract/searchEngineContract'
import { memoryIndex } from './helpers'

describeSearchEngineContract('SQLite FTS5 (node:sqlite)', {
  async open(notes) {
    const index = await memoryIndex()
    await index.applyDocs(notes)
    return {
      engine: index.searchEngine(),
      upsert: n => index.applyDoc(n),
      remove: id => index.removeDoc(id),
    }
  },
})
