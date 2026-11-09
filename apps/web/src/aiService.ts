// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'IA de la personne connectee : un seul service pour l'application, dont
// les connexions (et les cles) sont celles du compte actif, gardees sur ce
// poste. Les plugins n'en recoivent que la vue sans cle (aiService.pluginAPI()).
import { AIService, localAIConnectionStore, type AIConnectionStore } from '@savoire/application'

let accountId = 'anonyme'

function storage(): Pick<Storage, 'getItem' | 'setItem'> {
  try { return window.localStorage } catch { return { getItem: () => null, setItem: () => {} } }
}

const store: AIConnectionStore = {
  load: () => localAIConnectionStore(storage(), accountId).load(),
  save: list => localAIConnectionStore(storage(), accountId).save(list),
}

export const aiService = new AIService(store)

/** Le compte actif change : ses connexions a lui. */
export function setAIAccount(id: string | null | undefined): void {
  accountId = id || 'anonyme'
}
