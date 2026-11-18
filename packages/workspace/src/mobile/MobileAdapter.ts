// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Disposition mobile : un ecran a la fois, et un volet qui monte du bas.
// C'est l'autre moteur derriere WorkspacePort (le premier est Dockview,
// ADR-011). Le gestionnaire et les vues ne changent pas : ouvrir un fichier
// ouvre l'ecran de l'editeur, donner le focus a une vue de droite ouvre le
// volet sur elle.
//
// - Un ecran = un groupe (« explorer ») ou une vue de gauche ou du centre.
// - Le volet = un groupe ou une vue de droite (outils de la note, revision).
// - L'historique garde les ecrans visites : « retour » revient au precedent,
//   ou ferme d'abord le volet.

import type { WorkspacePort, WorkspaceLayout, OpenPanelOptions, PanelInstance, PanelLocation } from '../types'

/** Ou s'affiche un panneau : un ecran, ou le volet du bas. */
export type MobileTarget = { kind: 'screen'; screen: string } | { kind: 'sheet'; panel: string }

/** L'ecran de depart : l'editeur. */
export const EDITOR_SCREEN = 'editor-area'

const MAX_HISTORY = 50

export class MobileAdapter implements WorkspacePort {
  private history: string[]
  private sheet: string | null = null
  private locate: (panelId: string) => MobileTarget = id => ({ kind: 'screen', screen: id })
  private readonly changeListeners = new Set<() => void>()
  private readonly pushListeners = new Set<() => void>()
  private readonly activeListeners = new Set<(panelId: string | null) => void>()
  private readonly closeListeners = new Set<(panelId: string) => void>()

  /** `start` : le premier ecran (l'editeur par defaut). */
  constructor(start: string = EDITOR_SCREEN) {
    this.history = [start]
  }

  /** La racine dit ou va chaque panneau (selon les vues enregistrees). */
  setLocator(locate: (panelId: string) => MobileTarget): void {
    this.locate = locate
  }

  // ── Etat ─────────────────────────────────────────────────────────────────

  get screen(): string {
    return this.history[this.history.length - 1]
  }

  /** Panneau ouvert dans le volet, null = volet ferme. */
  get sheetPanel(): string | null {
    return this.sheet
  }

  canGoBack(): boolean {
    return this.sheet !== null || this.history.length > 1
  }

  /** Le panneau visible : celui du volet s'il est ouvert, sinon l'ecran. */
  activePanel(): string {
    return this.sheet ?? this.screen
  }

  // ── Navigation ───────────────────────────────────────────────────────────

  /** Ouvre un ecran. Le volet se ferme. */
  navigate(screen: string): void {
    const sheetWasOpen = this.sheet !== null
    this.sheet = null
    if (this.screen === screen) {
      if (sheetWasOpen) this.emit()
      return
    }
    this.history.push(screen)
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY)
    this.emitPush()
    this.emit()
  }

  /** Ouvre le volet sur un panneau, ou change de panneau s'il est deja ouvert. */
  openSheet(panel: string): void {
    if (this.sheet === panel) return
    const wasOpen = this.sheet !== null
    this.sheet = panel
    if (!wasOpen) this.emitPush()
    this.emit()
  }

  closeSheet(): void {
    if (this.sheet === null) return
    this.sheet = null
    this.emit()
  }

  /** Ferme le volet, ou revient a l'ecran precedent. false = rien a faire. */
  back(): boolean {
    if (this.sheet !== null) { this.closeSheet(); return true }
    if (this.history.length <= 1) return false
    this.history.pop()
    this.emit()
    return true
  }

  /** Affiche un panneau la ou il vit : son ecran, ou le volet. */
  show(panelId: string): void {
    const target = this.locate(panelId)
    if (target.kind === 'sheet') this.openSheet(target.panel)
    else this.navigate(target.screen)
  }

  // ── Abonnements ──────────────────────────────────────────────────────────

  subscribe(cb: () => void): () => void {
    this.changeListeners.add(cb)
    return () => { this.changeListeners.delete(cb) }
  }

  /** Un pas de plus dans l'historique : la racine ajoute une entree au navigateur. */
  subscribePush(cb: () => void): () => void {
    this.pushListeners.add(cb)
    return () => { this.pushListeners.delete(cb) }
  }

  /** Un panneau est ferme (plugin coupe, disposition) : sa vue se defait. */
  subscribeClose(cb: (panelId: string) => void): () => void {
    this.closeListeners.add(cb)
    return () => { this.closeListeners.delete(cb) }
  }

  subscribeActivePanelChange(cb: (panelId: string | null) => void): () => void {
    this.activeListeners.add(cb)
    return () => { this.activeListeners.delete(cb) }
  }

  // ── WorkspacePort ────────────────────────────────────────────────────────

  openPanel(panelId: string, _options?: OpenPanelOptions): PanelInstance {
    this.show(panelId)
    return {
      id: panelId,
      focus: () => this.show(panelId),
      close: () => this.closePanel(panelId),
    }
  }

  focusPanel(panelId: string): void {
    this.show(panelId)
  }

  closePanel(panelId: string): void {
    let changed = false
    if (this.sheet === panelId) { this.sheet = null; changed = true }
    if (panelId !== EDITOR_SCREEN && this.history.includes(panelId)) {
      this.history = this.history.filter(id => id !== panelId)
      if (this.history.length === 0) this.history = [EDITOR_SCREEN]
      changed = true
    }
    for (const cb of this.closeListeners) cb(panelId)
    if (changed) this.emit()
  }

  /** Replier le volet de droite ferme le volet du bas ; le volet gauche n'existe pas ici. */
  collapsePane(location: Exclude<PanelLocation, 'center'>, _panelIds: string[]): void {
    if (location === 'right') this.closeSheet()
  }

  /** Deplier le volet gauche (mode choisi) ouvre son ecran. Le volet du bas s'ouvre au focus. */
  expandPane(location: Exclude<PanelLocation, 'center'>, panelIds: string[]): void {
    if (location === 'left' && panelIds[0]) this.show(panelIds[0])
  }

  getPaneWidth(_panelIds: string[]): number {
    return 0
  }

  setPaneWidth(_panelIds: string[], _width: number): void {}

  saveLayout(): WorkspaceLayout {
    return { panels: [] }
  }

  restoreLayout(_layout: WorkspaceLayout): void {}

  private emit(): void {
    const active = this.activePanel()
    for (const cb of this.activeListeners) cb(active)
    for (const cb of this.changeListeners) cb()
  }

  private emitPush(): void {
    for (const cb of this.pushListeners) cb()
  }
}
