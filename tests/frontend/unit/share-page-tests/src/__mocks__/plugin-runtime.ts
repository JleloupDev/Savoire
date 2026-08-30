// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultPlugin, PluginAPI, FileTypeSpec } from '@savoire/plugin-api'

class FileTypeRegistryImpl {
  private readonly specs = new Map<string, FileTypeSpec>()
  register(spec: FileTypeSpec): void { this.specs.set(spec.extension, spec) }
  unregister(ext: string): void { this.specs.delete(ext) }
  resolve(ext: string): FileTypeSpec | undefined { return this.specs.get(ext) }
  getAll(): FileTypeSpec[] { return [...this.specs.values()] }
}

export class PluginLoader {
  async loadInternal(plugin: VaultPlugin, api: PluginAPI): Promise<void> {
    await plugin.onload(api)
  }
  async unloadAll(): Promise<void> {}
}

export class PluginAPIImpl {
  files = new FileTypeRegistryImpl()
  blocks = { register: () => {}, getAll: () => [], _currentPluginId: undefined as string | undefined }
  views = { _setCurrentPlugin: (_id: string | undefined) => {}, _cleanupPlugin: (_id: string) => {} }

  static create(_vault?: unknown): PluginAPIImpl { return new PluginAPIImpl() }
}
