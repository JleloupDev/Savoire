// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Presence d'un agent dans une note (ADR-033) : sa couleur. Quand il lit ou
// ecrit, les personnes qui ont la note ouverte voient un pair de plus, avec
// son curseur et son nom, dans cette couleur.
//
// La couleur se choisit dans Parametres → Agents. Sans choix, elle vient de
// l'id de l'agent : la meme partout (appli, pair du serveur), sans rien
// enregistrer.

/** Couleurs par defaut : lisibles en clair comme en sombre, distinctes entre elles. */
export const AGENT_COLORS: readonly string[] = [
  '#7c3aed', '#2563eb', '#0891b2', '#059669', '#ca8a04', '#ea580c', '#dc2626', '#db2777', '#4f46e5', '#0d9488',
]

/** « #rrggbb ». */
export function isAgentColor(c: unknown): c is string {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)
}

/** La couleur d'un agent : la sienne si elle est valide, sinon derivee de son id. */
export function agentColor(agent: { id: string; color?: string | undefined }): string {
  if (isAgentColor(agent.color)) return agent.color.toLowerCase()
  // FNV-1a sur l'id : stable, sans dependance.
  let h = 0x811c9dc5
  for (let i = 0; i < agent.id.length; i++) {
    h ^= agent.id.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return AGENT_COLORS[h % AGENT_COLORS.length]!
}
