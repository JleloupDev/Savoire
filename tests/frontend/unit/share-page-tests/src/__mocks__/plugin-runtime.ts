// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
export class PluginLoader {
  async loadInternal(_plugin: unknown, _api: unknown) {}
  async unloadAll() {}
}

export class PluginAPIImpl {
  files = { resolve: () => undefined }
  static create(_vault?: unknown, _sync?: unknown) { return new PluginAPIImpl() }
}
