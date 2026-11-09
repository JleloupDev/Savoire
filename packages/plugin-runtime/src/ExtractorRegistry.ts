// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Registre des extracteurs (plugin-api/extractors.ts). Le dernier enregistre
// pour une extension l'emporte ; le retirer rend la main au precedent.
import { extensionOfPath, type ExtractorRegistry, type ExtractorSpec } from '@savoire/plugin-api'

export class ExtractorRegistryImpl implements ExtractorRegistry {
  private readonly specs: ExtractorSpec[] = []
  private readonly listeners = new Set<() => void>()

  register(spec: ExtractorSpec): () => void {
    if (!spec.id || !spec.extensions.length) throw new Error('extracteur sans id ou sans extension')
    this.specs.push({ ...spec, extensions: spec.extensions.map(e => e.toLowerCase().replace(/^\./, '')) })
    const added = this.specs[this.specs.length - 1]
    this.emit()
    return () => {
      const i = this.specs.indexOf(added)
      if (i >= 0) { this.specs.splice(i, 1); this.emit() }
    }
  }

  forPath(path: string): ExtractorSpec | undefined {
    const ext = extensionOfPath(path)
    if (!ext) return undefined
    for (let i = this.specs.length - 1; i >= 0; i--) if (this.specs[i].extensions.includes(ext)) return this.specs[i]
    return undefined
  }

  list(): ExtractorSpec[] {
    return [...this.specs]
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  private emit(): void {
    for (const cb of this.listeners) cb()
  }
}
