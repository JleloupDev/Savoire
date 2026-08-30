// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultPlugin } from '@savoire/plugin-api'

const excalidrawPlugin: VaultPlugin = {
  manifest: { id: 'excalidraw', name: 'Excalidraw', version: '0.0.1', description: '' },
  onload: async (api) => {
    api.files.register({
      extension: 'excalidraw',
      label: 'Excalidraw',
      icon: '',
      create: async () => '{}',
      open: () => ({ mount: () => {}, destroy: () => {} }),
    })
  },
  onunload: async () => {},
}

export default excalidrawPlugin
