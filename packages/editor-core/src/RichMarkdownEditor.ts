// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { Crepe } from '@milkdown/crepe'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import type { ActivePluginInfo, EditorController, EditorEvent, MarkdownFormat, SelectionCoords } from './types'
import type { DocumentRoom, SyncAPI, ToolbarCommand, TriggerActivation, VaultAPI } from '@savoire/plugin-api'

interface RichMarkdownEditorOptions {
  container: HTMLElement
  path: string
  vault: VaultAPI
  readOnly?: boolean
  vaultId?: string
  docId?: string
  userId?: string
  sync?: SyncAPI
}

export class RichMarkdownEditor implements EditorController {
  private readonly container: HTMLElement
  private readonly path: string
  private readonly vault: VaultAPI
  private readonly readOnly: boolean
  private readonly vaultId?: string
  private readonly docId?: string
  private readonly userId?: string
  private readonly sync?: SyncAPI
  private readonly listeners = new Map<EditorEvent, Set<(...args: unknown[]) => void>>()
  private readonly toolbarCommands: ToolbarCommand[]
  private editorEl: HTMLElement | null = null
  private crepe: Crepe | null = null
  private room: DocumentRoom | null = null
  private roomUnsubSnapshot: (() => void) | null = null
  private markdown = ''
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false
  private applyingRemote = false

  constructor(options: RichMarkdownEditorOptions) {
    this.container = options.container
    this.path = options.path
    this.vault = options.vault
    this.readOnly = !!options.readOnly
    this.vaultId = options.vaultId
    this.docId = options.docId
    this.userId = options.userId
    this.sync = options.sync
    this.toolbarCommands = this.createToolbarCommands()
    this.mount()
  }

  private mount() {
    this.container.innerHTML = ''
    this.container.style.overflow = 'auto'
    void this.loadInitialContent()
  }

  private async loadInitialContent() {
    let source = ''
    try {
      source = await this.vault.readDocumentByPath(this.path)
    } catch {
      source = ''
    }
    if (this.destroyed) return
    this.markdown = source
    await this.mountCrepe(source)
    if (this.destroyed) return
    await this.connectRoom().catch(() => {})
    this.emit('fileOpened')
  }

  private async mountCrepe(content: string) {
    const crepe = new Crepe({
      root: this.container,
      defaultValue: content,
    })
    this.crepe = crepe
    crepe.setReadonly(this.readOnly)
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        this.markdown = markdown
        this.emit('documentChanged')
        if (!this.readOnly) this.scheduleSave()
        if (!this.readOnly && !this.applyingRemote) this.scheduleSyncPush()
      })
      listener.selectionUpdated(() => this.emit('selectionChanged'))
    })

    await crepe.create()
    if (this.destroyed) {
      await crepe.destroy().catch(() => {})
      return
    }

    this.editorEl = this.container.querySelector('.ProseMirror')
    if (this.editorEl) {
      this.editorEl.setAttribute('spellcheck', 'true')
      ;(this.editorEl as HTMLElement).style.outline = 'none'
    }
  }

  private async connectRoom(): Promise<void> {
    if (!this.sync || !this.vaultId || !this.docId || !this.userId) return
    const room = await this.sync.openRoom(this.vaultId, this.docId, this.userId)
    if (this.destroyed) {
      await room.close().catch(() => {})
      return
    }
    this.room = room
    this.roomUnsubSnapshot = room.onSnapshot((snapshotJson) => {
      if (this.destroyed) return
      if (snapshotJson === this.markdown) return
      void this.applyRemoteSnapshot(snapshotJson)
    })
  }

  private scheduleSyncPush() {
    if (!this.room) return
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => {
      void this.room?.pushSnapshot(this.markdown).catch(() => {})
    }, 250)
  }

  private async applyRemoteSnapshot(snapshot: string) {
    this.applyingRemote = true
    try {
      this.markdown = snapshot
      const old = this.crepe
      this.crepe = null
      this.editorEl = null
      this.container.innerHTML = ''
      await old?.destroy().catch(() => {})
      if (this.destroyed) return
      await this.mountCrepe(snapshot)
      this.emit('documentChanged')
    } finally {
      this.applyingRemote = false
    }
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      void this.save().catch(() => {})
    }, 600)
  }

  private emit(event: EditorEvent, ...args: unknown[]) {
    const handlers = this.listeners.get(event)
    if (!handlers) return
    for (const h of handlers) h(...args)
  }

  private exec(command: string, value?: string): void {
    if (this.readOnly) return
    this.focusEditor()
    document.execCommand(command, false, value)
    this.emit('selectionChanged')
  }

  private formatBlock(tag: string) {
    this.exec('formatBlock', tag)
  }

  private createToolbarCommands(): ToolbarCommand[] {
    return [
      { id: 'tb-bold', label: 'Gras', icon: 'B', group: 'format', run: () => this.toggleFormat('bold') },
      { id: 'tb-italic', label: 'Italique', icon: 'I', group: 'format', run: () => this.toggleFormat('italic') },
      { id: 'tb-strike', label: 'Barre', icon: 'S', group: 'format', run: () => this.toggleFormat('strike') },
      { id: 'tb-code', label: 'Code', icon: '</>', group: 'format', run: () => this.toggleFormat('code') },
      { id: 'tb-link', label: 'Lien', icon: '🔗', group: 'insert', run: () => this.toggleFormat('link') },
      { id: 'tb-h1', label: 'Titre 1', icon: 'H1', group: 'format', run: () => this.toggleFormat('h1') },
      { id: 'tb-h2', label: 'Titre 2', icon: 'H2', group: 'format', run: () => this.toggleFormat('h2') },
      { id: 'tb-ul', label: 'Liste', icon: '•', group: 'format', run: () => this.toggleFormat('ul') },
      { id: 'tb-ol', label: 'Liste num', icon: '1.', group: 'format', run: () => this.toggleFormat('ol') },
      { id: 'tb-quote', label: 'Citation', icon: '❝', group: 'format', run: () => this.toggleFormat('blockquote') },
      { id: 'tb-hr', label: 'Separateur', icon: '—', group: 'insert', run: () => this.toggleFormat('hr') },
    ]
  }

  async openFile(_path: string): Promise<void> {}

  async save(): Promise<void> {
    const docId = this.vault.resolveDocumentId(this.path)
    if (!docId) return
    this.markdown = this.exportMarkdown()
    await this.vault.write(docId, this.markdown)
    this.emit('fileSaved')
  }

  executeCommand(_id: string): void {}

  toggleFormat(format: MarkdownFormat): void {
    switch (format) {
      case 'bold': this.exec('bold'); break
      case 'italic': this.exec('italic'); break
      case 'strike': this.exec('strikeThrough'); break
      case 'code': this.exec('insertHTML', '<code>' + (this.getSelectionText() || 'code') + '</code>'); break
      case 'h1': this.formatBlock('H1'); break
      case 'h2': this.formatBlock('H2'); break
      case 'h3': this.formatBlock('H3'); break
      case 'h4': this.formatBlock('H4'); break
      case 'h5': this.formatBlock('H5'); break
      case 'h6': this.formatBlock('H6'); break
      case 'ul': this.exec('insertUnorderedList'); break
      case 'ol': this.exec('insertOrderedList'); break
      case 'blockquote': this.formatBlock('BLOCKQUOTE'); break
      case 'link': {
        const selected = this.getSelectionText() || 'Lien'
        const url = prompt('URL du lien', 'https://')
        if (!url) return
        this.exec('insertHTML', `<a href="${url}">${selected}</a>`)
        break
      }
      case 'hr': this.exec('insertHorizontalRule'); break
    }
  }

  getActiveFile(): string | null { return this.path }

  getConnectionStatus(): 'connected' | 'connecting' | 'disconnected' { return 'disconnected' }

  exportMarkdown(): string {
    return this.crepe?.getMarkdown() ?? this.markdown
  }

  destroy(): void {
    this.destroyed = true
    if (this.saveTimer) clearTimeout(this.saveTimer)
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.roomUnsubSnapshot?.()
    this.roomUnsubSnapshot = null
    const room = this.room
    this.room = null
    void room?.close().catch(() => {})
    const crepe = this.crepe
    this.crepe = null
    void crepe?.destroy().catch(() => {})
    this.container.innerHTML = ''
    this.editorEl = null
    this.listeners.clear()
  }

  on(event: EditorEvent, handler: (...args: unknown[]) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(handler)
    return () => set?.delete(handler)
  }

  getSelectionCoords(): SelectionCoords | null {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return null
    const range = sel.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    if (!rect.width && !rect.height) return null
    return { x: rect.left + rect.width / 2, y: rect.top }
  }

  getSelectionText(): string {
    return window.getSelection()?.toString() ?? ''
  }

  getActiveTrigger(): TriggerActivation | null { return null }

  commitTriggerInsert(_from: number, _triggerCharLen: number, _query: string, insert: string): void {
    this.insertText(insert)
  }

  getToolbarCommands(): ToolbarCommand[] {
    return this.toolbarCommands
  }

  runToolbarCommand(id: string): void {
    const cmd = this.toolbarCommands.find(c => c.id === id)
    cmd?.run({} as never)
  }

  insertText(text: string): void {
    if (this.readOnly) return
    this.focusEditor()
    this.exec('insertText', text)
  }

  getActivePlugins(): ActivePluginInfo[] {
    return []
  }

  private focusEditor() {
    this.editorEl?.focus()
  }
}
