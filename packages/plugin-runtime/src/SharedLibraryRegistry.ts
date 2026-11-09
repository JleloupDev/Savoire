// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Registre des bibliotheques communes (voir plugin-api/libraries.ts).
//
// L'hote enregistre, pour chaque bibliotheque de la liste, une fonction qui la
// charge (un import() de SA copie). Rien n'est charge d'avance : seulement ce
// qu'un plugin demande. Ensuite `require(id)` rend la bibliotheque tout de
// suite, comme l'attend un paquet CommonJS.
import { UnknownLibraryError, isSharedLibrary, type ISharedLibraries, type SharedLibraryId } from '@savoire/plugin-api'

type Loader = () => Promise<unknown>

export class SharedLibraryRegistry implements ISharedLibraries {
  private readonly loaders = new Map<SharedLibraryId, Loader>()
  private readonly loaded = new Map<SharedLibraryId, unknown>()
  private readonly pending = new Map<SharedLibraryId, Promise<unknown>>()

  /**
   * L'hote fournit une bibliotheque de la liste commune. `loader` rend la
   * valeur que recevra `require(id)` (pour React : l'objet du module).
   */
  provide(id: SharedLibraryId, loader: Loader): this {
    if (!isSharedLibrary(id)) throw new UnknownLibraryError(id)
    this.loaders.set(id, loader)
    return this
  }

  list(): SharedLibraryId[] {
    return [...this.loaders.keys()]
  }

  get<T = unknown>(id: SharedLibraryId): T {
    if (!this.loaders.has(id)) throw new UnknownLibraryError(id)
    if (!this.loaded.has(id)) throw new Error(`Bibliothèque « ${id} » pas encore chargée : appelez load() d'abord.`)
    return this.loaded.get(id) as T
  }

  load<T = unknown>(id: SharedLibraryId): Promise<T> {
    const loader = this.loaders.get(id)
    if (!loader) return Promise.reject(new UnknownLibraryError(id))
    if (this.loaded.has(id)) return Promise.resolve(this.loaded.get(id) as T)
    let p = this.pending.get(id)
    if (!p) {
      p = loader().then(value => {
        this.loaded.set(id, value)
        this.pending.delete(id)
        return value
      }, err => { this.pending.delete(id); throw err })
      this.pending.set(id, p)
    }
    return p as Promise<T>
  }

  /** Charge tout ce que demande un plugin ; refuse une bibliotheque hors liste. */
  async loadAll(ids: readonly string[]): Promise<void> {
    for (const id of ids) if (!isSharedLibrary(id) || !this.loaders.has(id)) throw new UnknownLibraryError(id)
    await Promise.all(ids.map(id => this.load(id as SharedLibraryId)))
  }

  /** Le `require` d'un plugin CommonJS : bibliotheques communes seulement, deja chargees. */
  createRequire(): (id: string) => unknown {
    return (id: string) => {
      if (!isSharedLibrary(id) || !this.loaders.has(id)) throw new UnknownLibraryError(id)
      return this.get(id)
    }
  }
}

/** Les `require('…')` ecrits en clair dans le code d'un plugin (pour les charger avant lui). */
export function requiredLibraries(code: string): string[] {
  const found = new Set<string>()
  for (const m of code.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)) found.add(m[2])
  return [...found]
}
