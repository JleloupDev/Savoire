// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// MCP local (ADR-033) : ce que la page repond a un client MCP du poste
// (Claude Desktop, Claude Code) que la coquille bureau relaie
// (apps/desktop/src-tauri/src/mcp_local.rs). Seul le JSON-RPC est ici : les
// outils, les droits de l'agent choisi et les accords « demander » sont ceux
// de la boite d'outils de l'appli (ToolBox), comme pour l'assistant. Aucune
// seconde politique.
import type { ToolBox } from '@savoire/agent-core'

/** Memes versions que le MCP du serveur (backend/src/api/open.rs). */
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

const INSTRUCTIONS =
  'Savoire, sur ce poste. Vous agissez comme l’agent choisi dans Savoire (Paramètres → Agents → MCP local), avec ses droits : ' +
  'ce qu’il n’a pas le droit de faire n’est pas proposé, et une action « demander » attend l’accord de la personne dans la fenêtre de Savoire.'

export interface LocalMcpDeps {
  /**
   * La boite d'outils de l'agent choisi, pour le vault ouvert. Leve une erreur
   * lisible (MCP coupe, aucun agent choisi, aucun vault ouvert...).
   */
  toolBox(): Promise<ToolBox>
}

type Id = string | number | null

const ok = (id: Id, result: unknown): string => JSON.stringify({ jsonrpc: '2.0', id, result })
const fail = (id: Id, code: number, message: string): string => JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })

/** Un message JSON-RPC du client ; la reponse en texte JSON, ou '' pour une notification. */
export async function handleLocalMcp(body: string, deps: LocalMcpDeps): Promise<string> {
  let msg: unknown
  try { msg = JSON.parse(body) } catch { return fail(null, -32700, 'JSON illisible.') }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || (msg as { jsonrpc?: unknown }).jsonrpc !== '2.0') {
    return fail(null, -32600, 'Requête JSON-RPC 2.0 attendue (un seul message, pas de lot).')
  }
  const m = msg as { id?: Id; method?: unknown; params?: unknown }
  // Notification (pas d'id) ou reponse du client : rien a rendre.
  if (typeof m.method !== 'string' || !('id' in m)) return ''
  const id: Id = typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null
  const params = m.params && typeof m.params === 'object' ? m.params as Record<string, unknown> : {}

  switch (m.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      return ok(id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'savoire-local', title: 'Savoire (poste)', version: '0.1.0' },
        instructions: INSTRUCTIONS,
      })
    }
    case 'ping': return ok(id, {})
    case 'resources/list': return ok(id, { resources: [] })
    case 'prompts/list': return ok(id, { prompts: [] })
    case 'tools/list': {
      try {
        const box = await deps.toolBox()
        return ok(id, {
          tools: box.specs().map(s => ({
            name: s.name, title: s.title, description: s.description, inputSchema: s.inputSchema,
            annotations: { readOnlyHint: s.action === 'read', openWorldHint: false },
          })),
        })
      } catch (err) {
        return fail(id, -32603, messageOf(err))
      }
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {}
      if (!name) return fail(id, -32602, 'Nom d’outil attendu.')
      let box: ToolBox
      try { box = await deps.toolBox() } catch (err) { return fail(id, -32603, messageOf(err)) }
      if (!box.has(name)) return fail(id, -32602, `Outil inconnu ou non permis à cet agent : ${name}.`)
      try {
        const out = await box.call(name, args)
        return ok(id, {
          content: [{ type: 'text', text: out.result.text }],
          ...(out.result.data !== undefined ? { structuredContent: toRecord(out.result.data) } : {}),
          isError: out.result.isError === true,
        })
      } catch (err) {
        return ok(id, { content: [{ type: 'text', text: `Échec : ${messageOf(err)}` }], isError: true })
      }
    }
    default:
      return fail(id, -32601, `Méthode inconnue : ${m.method}.`)
  }
}

/** structuredContent doit etre un objet : un tableau ou une valeur est enveloppe. */
function toRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : { result: data }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
