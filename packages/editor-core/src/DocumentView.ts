// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { EditorCore } from './EditorCore'
import { RichMarkdownEditor } from './RichMarkdownEditor'
import type { EditorController } from './types'
import type {
  FileContext,
  FileTypeRegistry,
  FileView,
  IPluginLoader,
  SyncAPI,
  VaultAPI,
  VaultPlugin,
} from '@savoire/plugin-api'

export interface DocumentViewOptions {
  path: string
  container: HTMLElement
  vault: VaultAPI
  sync?: SyncAPI
  fileTypeRegistry: FileTypeRegistry
  vaultId: string
  docId?: string
  userId?: string
  readOnly?: boolean
  pluginAPI?: import('@savoire/plugin-api').IEditorHostAPI
  defaultPlugins?: VaultPlugin[]
  pluginRegistry?: Record<string, () => Promise<VaultPlugin>>
  serverUrl?: string
  clientId?: string
  editorMode?: 'source' | 'rich'
  /** Factory for the per-document plugin loader — injected so editor-core stays free of plugin-runtime. */
  createPluginLoader?: () => IPluginLoader
  /** JWT token factory for authenticated SignalR hubs. */
  getToken?: () => string | null
  /**
   * Appelé quand un FileView non-Markdown stabilise son contenu.
   * Le contenu est déjà converti en shadow Markdown via contentExtractor.toShadowDocument().
   * Branché sur ContentIndexingService.indexNow() par l'app layer.
   */
  onFileContentStabilized?: (docId: string, path: string, shadowMarkdown: string) => void
}

export class DocumentView {
  private readonly options: DocumentViewOptions
  private readonly ext: string
  private readonly fileTypeSpec: ReturnType<FileTypeRegistry['resolve']>
  private editorController: EditorController | null = null
  private pluginFileView: FileView | null = null

  constructor(options: DocumentViewOptions) {
    this.options = options
    this.ext = options.path.split('.').pop()?.toLowerCase() ?? ''
    this.fileTypeSpec = options.fileTypeRegistry.resolve(this.ext)
  }

  mount(): void {
    if (this.editorController || this.pluginFileView) return

    if (this.fileTypeSpec?.open) {
      const spec = this.fileTypeSpec
      const open = spec.open as NonNullable<typeof spec.open>
      const fileCtx: FileContext = {
        vaultId: this.options.vaultId,
        path: this.options.path,
        userId: this.options.userId,
        vault: this.options.vault,
        onContentStabilized: spec.contentExtractor
          ? (rawContent: string) => {
              const shadow = spec.contentExtractor!.toShadowDocument(rawContent)
              this.options.onFileContentStabilized?.(
                this.options.docId ?? '',
                this.options.path,
                shadow,
              )
            }
          : undefined,
      }
      this.pluginFileView = open(this.options.path, fileCtx)
      this.pluginFileView.mount(this.options.container)
      return
    }

    const isMarkdown = this.ext === 'md'
    if (isMarkdown && this.options.editorMode === 'rich') {
      this.editorController = new RichMarkdownEditor({
        container: this.options.container,
        path: this.options.path,
        vault: this.options.vault,
        readOnly: this.options.readOnly,
        vaultId: this.options.vaultId,
        docId: this.options.docId,
        userId: this.options.userId,
        sync: this.options.pluginAPI?.sync,
      })
      return
    }

    this.editorController = new EditorCore({
      container: this.options.container,
      serverUrl: this.options.serverUrl,
      vaultId: this.options.vaultId,
      docId: this.options.docId,
      userId: this.options.userId,
      clientId: this.options.clientId,
      vault: this.options.vault,
      readOnly: this.options.readOnly,
      filePath: this.options.path,
      pluginRegistry: this.options.pluginRegistry,
      defaultPlugins: this.options.defaultPlugins,
      getToken: this.options.getToken,
      pluginAPI: this.options.pluginAPI,
      createPluginLoader: this.options.createPluginLoader,
    })
  }

  destroy(): void {
    this.pluginFileView?.destroy()
    this.pluginFileView = null
    this.editorController?.destroy()
    this.editorController = null
  }

  get controller(): EditorController | null {
    return this.editorController
  }

  get fileView(): FileView | null {
    return this.pluginFileView
  }
}
