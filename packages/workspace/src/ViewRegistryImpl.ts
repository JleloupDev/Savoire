// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { ViewRegistry, ViewSpec } from '@savoire/plugin-api'

export class ViewRegistryImpl implements ViewRegistry {
  private readonly specs = new Map<string, ViewSpec>()

  register(spec: ViewSpec): void {
    this.specs.set(spec.id, spec)
  }

  unregister(id: string): void {
    this.specs.delete(id)
  }

  getAll(): ViewSpec[] {
    return Array.from(this.specs.values())
  }

  get(id: string): ViewSpec | undefined {
    return this.specs.get(id)
  }
}
