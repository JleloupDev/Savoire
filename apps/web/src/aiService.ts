// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'IA de la personne connectee : un seul service pour l'application, dont
// les connexions (et les cles) sont celles du compte actif, gardees sur ce
// poste. Les plugins n'en recoivent que la vue sans cle (aiService.pluginAPI()).
//
// Bureau : le protocole « claude-cli » (Claude avec l'abonnement de la
// personne, plugin-ai-claude-code) est servi par la coquille, qui lance le
// programme claude du poste.
import { AIService, localAIConnectionStore, type AIConnectionStore } from '@savoire/application'
import { desktopClaudeCliRunner } from './claudeCliDesktop'
import { isAndroidRuntime, isTauriRuntime } from './tauriRuntime'

let accountId = 'anonyme'

function storage(): Pick<Storage, 'getItem' | 'setItem'> {
  try { return window.localStorage } catch { return { getItem: () => null, setItem: () => {} } }
}

const store: AIConnectionStore = {
  load: () => localAIConnectionStore(storage(), accountId).load(),
  save: list => localAIConnectionStore(storage(), accountId).save(list),
}

export const aiService = new AIService(store)

if (isTauriRuntime() && !isAndroidRuntime()) {
  const claude = desktopClaudeCliRunner()
  aiService.registerRunner(claude)
  // Page rechargee ou fenetre fermee : ses demandes a Claude s'arretent.
  window.addEventListener('pagehide', () => claude.stopAll())
}

/** Le compte dont les connexions sont chargees (reglages de la dictee). */
export function aiAccount(): string {
  return accountId
}

/** Le compte actif change : ses connexions a lui. */
export function setAIAccount(id: string | null | undefined): void {
  accountId = id || 'anonyme'
}
