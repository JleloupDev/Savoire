// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { EditorCore } from './EditorCore'
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
  crdt?: import('@savoire/plugin-api').ICRDT
  getTransportState?: () => 'connected' | 'connecting' | 'disconnected'
  editorMode?: 'source' | 'rich'
  /** Factory for the per-document plugin loader — injected so editor-core stays free of plugin-runtime. */
  createPluginLoader?: () => IPluginLoader
  /**
   * Called when a non-Markdown FileView has stabilised its content.
   * Content is already converted to shadow Markdown via contentExtractor.toShadowDocument().
   * Wired to ContentIndexingService.indexNow() by the app layer.
   */
  onFileContentStabilized?: (docId: string, path: string, shadowMarkdown: string) => void
  /**
   * Message affiche quand aucun plugin actif n'ouvre ce type de fichier (son
   * plugin est desactive, ou n'existe pas). Defaut : un message generique.
   */
  unsupportedMessage?: string
}

/** Seul le Markdown est ouvert par l'editeur lui-meme ; tout autre type exige un plugin. */
export function isOpenableWithoutPlugin(ext: string): boolean {
  return ext === 'md'
}

export class DocumentView {
  private readonly options: DocumentViewOptions
  private readonly ext: string
  private readonly fileTypeSpec: ReturnType<FileTypeRegistry['resolve']>
  private editorController: EditorController | null = null
  private pluginFileView: FileView | null = null
  private unsupported: HTMLElement | null = null

  constructor(options: DocumentViewOptions) {
    this.options = options
    this.ext = options.path.split('.').pop()?.toLowerCase() ?? ''
    this.fileTypeSpec = options.fileTypeRegistry.resolve(this.ext)
  }

  mount(): void {
    if (this.editorController || this.pluginFileView || this.unsupported) return

    // Aucun plugin actif pour ce type : une fiche en lecture seule, qui
    // n'ecrit jamais rien. Surtout pas l'editeur Markdown, qui ouvrirait un
    // document vide a la place du fichier et laisserait taper dedans.
    // Un type ACTIF sans open() est, lui, confie a l'editeur Markdown : c'est
    // le contrat de FileTypeSpec.open.
    if (!this.fileTypeSpec && !isOpenableWithoutPlugin(this.ext)) {
      const el = document.createElement('div')
      el.dataset.testid = 'unsupported-file'
      el.style.cssText = [
        'max-width:520px', 'margin:48px auto', 'padding:24px', 'border-radius:8px',
        'border:1px solid var(--border,#313244)', 'font-family:var(--font-ui,sans-serif)',
        'font-size:13px', 'line-height:1.5', 'color:var(--text-muted,#a6adc8)',
      ].join(';')
      el.textContent = this.options.unsupportedMessage
        ?? `Aucun plugin actif n'ouvre les fichiers .${this.ext}. Le fichier est intact.`
      this.options.container.replaceChildren(el)
      this.unsupported = el
      return
    }

    if (this.fileTypeSpec?.open) {
      const spec = this.fileTypeSpec
      const open = spec.open as NonNullable<typeof spec.open>
      const fileCtx: FileContext = {
        vaultId: this.options.vaultId,
        path: this.options.path,
        userId: this.options.userId,
        vault: this.options.vault,
        readOnly: this.options.readOnly,
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

    // Un SEUL editeur pour les deux modes : meme CodeMirror, meme Y.Text.
    // Le mode ne change que le rendu — « rich » active le live preview,
    // « source » montre le Markdown brut. Rien a convertir entre les deux,
    // et donc rien a changer cote synchronisation.
    this.editorController = new EditorCore({
      editorMode: this.options.editorMode ?? 'rich',
      container: this.options.container,
      crdt: this.options.crdt as import('./types').ICodeMirrorCRDT | undefined,
      getTransportState: this.options.getTransportState,
      docId: this.options.docId,
      userId: this.options.userId,
      vault: this.options.vault,
      readOnly: this.options.readOnly,
      filePath: this.options.path,
      pluginRegistry: this.options.pluginRegistry,
      defaultPlugins: this.options.defaultPlugins,
      pluginAPI: this.options.pluginAPI,
      createPluginLoader: this.options.createPluginLoader,
    })
  }

  destroy(): void {
    this.unsupported?.remove()
    this.unsupported = null
    this.pluginFileView?.destroy()
    this.pluginFileView = null
    this.editorController?.destroy()
    this.editorController = null
  }

  /**
   * Bascule la vue en lecture seule sans la remonter. Rend false si la vue
   * ouverte ne sait pas le faire — l'appelant doit alors remonter.
   */
  setReadOnly(readOnly: boolean): boolean {
    this.options.readOnly = readOnly
    if (this.pluginFileView?.setReadOnly) {
      this.pluginFileView.setReadOnly(readOnly)
      return true
    }
    return false
  }

  get controller(): EditorController | null {
    return this.editorController
  }

  get fileView(): FileView | null {
    return this.pluginFileView
  }
}
