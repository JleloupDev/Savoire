// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le moteur de requetes SQL (pouvoir query) passe le contrat commun, a
// l'identique du moteur de reference en memoire.
import { describeQueryEngineContract } from '../../plugin-runtime-tests/src/contract/queryEngineContract'
import { memoryIndex, recordOf } from './helpers'

describeQueryEngineContract('SQLite (node:sqlite)', {
  async open(docs) {
    const index = await memoryIndex()
    await index.applyRecords(docs.map(recordOf))
    return {
      engine: index.queryEngine(),
      upsert: d => index.applyRecords([recordOf(d)]),
      remove: id => index.removeDoc(id),
    }
  },
})
