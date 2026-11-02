// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Point d'entree de Savoire Indexer (un seul fichier construit par esbuild,
// dist/indexer.mjs). Le meme fichier sert de programme principal et de code
// des fils d'indexation (worker_threads).
//
//   node dist/indexer.mjs            demarre le service (configuration : SAVOIRE_INDEXER_*)
//   node dist/indexer.mjs --help     liste des variables (--markdown : table du README)
//   node dist/indexer.mjs --check    verifie la configuration et s'arrete
//
// Arret propre sur SIGTERM / SIGINT ; un second signal arrete tout de suite.
import { fileURLToPath } from 'node:url'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { ConfigError, loadConfig, redacted, settingsTable } from './config'
import { createLogger } from './log'
import { IndexerService } from './service'
import { Shard } from './shard'
import type { FromShard, ShardInit, ToShard } from './shard'

declare const __INDEXER_VERSION__: string
const VERSION = typeof __INDEXER_VERSION__ === 'string' ? __INDEXER_VERSION__ : 'dev'

function runWorker(init: ShardInit): void {
  const log = createLogger(init.config.logLevel, { svc: 'savoire-indexer', instance: init.config.name, shard: init.index })
  const port = parentPort!
  const shard = new Shard(init, log, (msg: FromShard) => port.postMessage(msg))
  port.on('message', (msg: ToShard) => shard.handle(msg))
  process.on('uncaughtException', err => { log.error('exception non rattrapee dans un fil', { err }); process.exit(70) })
}

async function runMain(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`Savoire Indexer ${VERSION} : pair indexeur (ADR-027).\n\nVariables d'environnement :\n\n${settingsTable(argv.includes('--markdown'))}\n`)
    return
  }
  let loaded
  try {
    loaded = loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(JSON.stringify({ t: new Date().toISOString(), level: 'error', msg: 'configuration invalide', svc: 'savoire-indexer', problems: err.problems }) + '\n')
      process.exit(78)
    }
    throw err
  }
  const { config, warnings } = loaded
  const log = createLogger(config.logLevel, { svc: 'savoire-indexer', instance: config.name })
  for (const w of warnings) log.warn(w)
  if (argv.includes('--check')) {
    log.info('configuration valide', { config: redacted(config) })
    return
  }
  log.info('configuration', { version: VERSION, config: redacted(config) })

  const service = new IndexerService({ config, log, version: VERSION, workerFile: fileURLToPath(import.meta.url) })
  let signals = 0
  const onSignal = (sig: string) => {
    if (++signals > 1) { log.warn('second signal : arret immediat', { signal: sig }); process.exit(1) }
    service.stop(sig).then(() => process.exit(0), err => { log.error('arret difficile', { err }); process.exit(1) })
  }
  process.on('SIGTERM', () => onSignal('SIGTERM'))
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('unhandledRejection', err => log.error('promesse rejetee sans gestionnaire', { err }))
  try {
    await service.start()
  } catch (err) {
    log.error('demarrage impossible', { err })
    await service.stop('echec du demarrage').catch(() => undefined)
    process.exit(1)
  }
}

if (!isMainThread && (workerData as { role?: string } | null)?.role === 'shard') {
  runWorker((workerData as { init: ShardInit }).init)
} else if (isMainThread) {
  void runMain(process.argv.slice(2))
}
