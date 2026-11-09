// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Vrai PDF : TeX Live compile en WebAssembly dans le navigateur (moteur
// Siglum, licence MIT, base sur BusyTeX). Rien ne part sur un serveur : le
// document est compile sur le poste. Le moteur (une trentaine de Mo) et les
// paquets LaTeX sont telecharges a la premiere compilation, puis gardes en
// cache par le navigateur (compilation hors ligne ensuite).
//
// Ce module n'est charge qu'au premier clic sur « Compiler en PDF ».
/// <reference path="./url.d.ts" />
import { SiglumCompiler, resolveRuntime } from '@siglum/engine'
import workerUrl from '@siglum/engine/worker?url'

export interface CompileResult {
  ok: boolean
  pdf?: Uint8Array
  /** Message d'erreur et fin du journal de TeX. */
  error?: string
  log?: string
}

let compiler: Promise<SiglumCompiler> | null = null

async function engine(): Promise<SiglumCompiler> {
  compiler ??= (async () => {
    const c = new SiglumCompiler({ ...(await resolveRuntime()), workerUrl })
    await c.init()
    return c
  })().catch(err => { compiler = null; throw err })
  return compiler
}

export async function compileLatex(source: string): Promise<CompileResult> {
  const c = await engine()
  const r = await c.compile(source) as { success: boolean; pdf?: Uint8Array; log?: string; error?: string }
  if (r.success && r.pdf) return { ok: true, pdf: r.pdf, log: r.log }
  const tail = (r.log ?? '').split('\n').filter(l => /^!|error|Error/.test(l)).slice(0, 8).join('\n')
  return { ok: false, error: r.error ?? 'La compilation a échoué.', log: tail || r.log?.slice(-2000) }
}
