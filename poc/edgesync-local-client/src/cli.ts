#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// edgesync-client --vault <dossier> --listen <port>
// edgesync-client --vault <dossier> --dial ws://<host>:<port>
import { VaultClient } from './client'

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1] ?? ''
      i++
    }
  }
  return args
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.vault) {
    throw new Error('usage: edgesync-client --vault <dossier> (--listen <port> | --dial ws://host:port)')
  }
  if (!args.listen && !args.dial) {
    throw new Error('un de --listen <port> ou --dial <url> est requis')
  }

  const client = await VaultClient.open({ vaultDir: args.vault })

  if (args.listen) {
    await client.listen(Number(args.listen))
  } else {
    await client.dial(args.dial)
  }

  const shutdown = async (): Promise<void> => {
    await client.persist()
    client.dispose()
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
