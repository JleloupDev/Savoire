// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les moteurs distants (pair indexeur par les routes publiques) passent les
// contrats communs, a l'identique du moteur en memoire et du SQLite local :
// le faux backend relaie a un vrai index (indexer-core, node:sqlite). C'est
// la preuve que le transport (JSON, erreurs, curseurs, etat) ne trahit pas
// le contrat.
import { describeQueryEngineContract } from '../../plugin-runtime-tests/src/contract/queryEngineContract'
import { describeSearchEngineContract } from '../../plugin-runtime-tests/src/contract/searchEngineContract'
import { makeRecord } from '@savoire/indexer-core'
import type { IndexedDoc } from '@savoire/plugin-runtime'
import { IndexerHttpClient, RemoteVaultIndexer } from '@savoire/infrastructure-sync'
import { fakeIndexerBackend, memoryIndex } from './support/fakeIndexerBackend'

function recordOf(d: IndexedDoc) {
  return makeRecord({
    id: d.id, path: d.path, title: d.title, props: d.props, text: d.text,
    ...(d.base !== undefined ? { base: d.base } : {}),
  })
}

/** Minuteurs qui ne retiennent pas le processus de test. */
const timers = {
  setTimer: (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms)
    ;(t as { unref?: () => void }).unref?.()
    return t
  },
}

function remoteOn(index: Awaited<ReturnType<typeof memoryIndex>>): RemoteVaultIndexer {
  const backend = fakeIndexerBackend({ v1: index })
  return new RemoteVaultIndexer('v1', new IndexerHttpClient({ getToken: () => 'tok', fetchFn: backend.fetch }), timers)
}

describeQueryEngineContract('pair indexeur distant (faux backend, indexer-core)', {
  async open(docs) {
    const index = await memoryIndex()
    let seq = 1
    await index.applyRecords(docs.map(recordOf), { seq })
    const remote = remoteOn(index)
    return {
      engine: remote.query,
      // Une ecriture du pair, puis l'appli regarde : les requetes suivies se relancent.
      upsert: async d => { await index.applyRecords([recordOf(d)], { seq: ++seq }); await remote.refreshNow() },
      remove: async id => { await index.removeDoc(id, { seq: ++seq }); await remote.refreshNow() },
    }
  },
})

describeSearchEngineContract('pair indexeur distant (faux backend, indexer-core)', {
  async open(notes) {
    const index = await memoryIndex()
    let seq = 1
    await index.applyDocs(notes, { seq })
    const remote = remoteOn(index)
    return {
      engine: remote.search,
      upsert: async n => { await index.applyDoc(n, { seq: ++seq }) },
      remove: async id => { await index.removeDoc(id, { seq: ++seq }) },
    }
  },
})
