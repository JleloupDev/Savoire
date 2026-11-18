// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La racine de l'espace de travail sur mobile : une barre en haut (retour,
// titre, actions), un ecran a la fois, une barre d'onglets en bas, et un volet
// qui monte du bas pour les panneaux de droite. Memes vues, meme gestionnaire
// que sur le bureau (WorkspaceRoot) : seul le moteur de disposition change.
//
// Le bouton retour du telephone passe par l'historique du navigateur : chaque
// ecran ouvert y ajoute une entree, « retour » la retire et revient en arriere.

import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ViewContext, ViewSpec, Widget, FileTypeRegistry } from '@savoire/plugin-api'
import { t } from '@savoire/i18n'
import { WorkspaceManagerImpl } from '../WorkspaceManagerImpl'
import { WorkspaceContext } from '../WorkspaceContext'
import type { WorkspaceRootProps } from '../WorkspaceRoot'
import { MobileAdapter, EDITOR_SCREEN } from './MobileAdapter'
import { consumeMobileBack, pushMobileHistory } from './backStack'
import { bottomTabs, locatePanel, panelViews, sheetTabs } from './mobileLayout'
import type { MobileTab } from './mobileLayout'
import './mobile.css'

/** L'ecran « Plus » : onglets en trop, et ce que l'application y met. */
export const MORE_SCREEN = 'mobile-more'

export interface MobileWorkspaceRootProps extends WorkspaceRootProps {
  /** Titre de l'ecran de l'editeur : la note ouverte. */
  editorTitle?: string
  /** Boutons de la barre du haut, sur l'ecran de l'editeur. */
  editorActions?: ReactNode
  /** Contenu de l'ecran « Plus » (reglages, compte...). */
  more?: ReactNode
  /** Dessine une icone par son nom (celles des vues et des groupes). */
  renderIcon?: (name: string | undefined) => ReactNode
  /** Le premier ecran : l'explorateur (on choisit d'abord une note), sinon l'editeur. */
  startScreen?: string
  /** Onglets a mettre en premier dans la barre du bas, apres le premier ecran et la note. */
  tabPriority?: string[]
}

const noopFileTypeRegistry: FileTypeRegistry = {
  register: () => {},
  unregister: () => {},
  resolve: () => undefined,
  getAll: () => [],
}

/** Une vue montee une fois : elle garde son etat quand on change d'ecran. */
function ViewHost({ spec, ctx }: { spec: ViewSpec; ctx: ViewContext }) {
  const [widget] = useState<Widget>(() => spec.createView(ctx))
  useEffect(() => () => { widget.dispose?.() }, [widget])
  return <div className="workspace-view-host mobile-view-host" data-view-id={spec.id}>{widget.render() as ReactNode}</div>
}

/** Les vues d'un panneau, l'une sous l'autre (un groupe), ou la vue seule. */
function PanelHost({ manager, panelId, ctx }: { manager: WorkspaceManagerImpl; panelId: string; ctx: ViewContext }) {
  const specs = panelViews(manager.views, panelId)
  if (specs.length === 1) return <ViewHost key={specs[0].id} spec={specs[0]} ctx={ctx} />
  return (
    <div className="mobile-panel-stack">
      {specs.map(spec => (
        <section key={spec.id} className="mobile-panel-section">
          {/* Chaque vue porte deja son titre. */}
          <ViewHost spec={spec} ctx={ctx} />
        </section>
      ))}
    </div>
  )
}

function BackIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  )
}

function PanelsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 15h18" />
    </svg>
  )
}

function MoreIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  )
}

/** Un clavier fait au moins cette hauteur (px) ; en dessous, une barre d'adresse qui bouge. */
const KEYBOARD_MIN = 120

/** Un champ ou l'editeur a le focus : le clavier est ouvert, la barre du bas se cache. */
function isEditable(el: Element | null): boolean {
  if (!el) return false
  if ((el as HTMLElement).isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA') return true
  if (tag !== 'INPUT') return false
  const type = (el as HTMLInputElement).type
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(type)
}

export function MobileWorkspaceRoot({ vault, fileTypesRef, onBeforeReady, onReady, className, style, editorTitle, editorActions, more, renderIcon, tabPriority, startScreen }: MobileWorkspaceRootProps) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const adapter = useMemo(() => new MobileAdapter(startScreen), [])
  const manager = useMemo(() => new WorkspaceManagerImpl(adapter), [adapter])
  const [, refresh] = useReducer((n: number) => n + 1, 0)
  const [ctx, setCtx] = useState<ViewContext | null>(null)
  // Clavier ouvert = un champ a le focus ET l'ecran visible a retreci. Le
  // focus seul ne suffit pas : fermer le clavier (retour d'Android) laisse
  // le focus dans l'editeur.
  const [editing, setEditing] = useState(false)
  const [shrunk, setShrunk] = useState(false)
  const keyboard = editing && shrunk
  // Ecrans et onglets du volet deja ouverts : montes une fois, puis caches.
  const visited = useRef(new Set<string>([EDITOR_SCREEN, adapter.screen]))
  const visitedSheet = useRef(new Set<string>())

  // Meme garde que WorkspaceRoot : en StrictMode, le premier montage jete ne
  // doit pas finir son installation (plugins) apres coup.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    adapter.setLocator(id => locatePanel(manager.views, id))
    const offChange = adapter.subscribe(refresh)
    const offClose = adapter.subscribeClose(id => {
      visited.current.delete(id)
      visitedSheet.current.delete(id)
    })
    // Le bouton retour : une entree d'historique par pas, retiree au retour.
    // Une fenetre ouverte (parametres...) passe avant : elle se ferme.
    const offPush = adapter.subscribePush(pushMobileHistory)
    const onPop = () => { if (!consumeMobileBack()) adapter.back() }
    window.addEventListener('popstate', onPop)
    // D'une note a l'autre : un pas d'historique ; « retour » rouvre la precedente.
    const offOpen = manager.subscribeOpenFile(path => adapter.openDocument(path))
    const offReopen = adapter.subscribeReopen(path => { void manager.openFile(path) })
    return () => { offChange(); offClose(); offPush(); offOpen(); offReopen(); window.removeEventListener('popstate', onPop) }
  }, [adapter, manager])

  useEffect(() => {
    let cancelled = false
    void Promise.resolve(onBeforeReady?.(manager)).then(() => {
      if (cancelled || !mountedRef.current) return
      const viewCtx: ViewContext = { workspace: manager, vault, fileTypes: fileTypesRef?.current ?? noopFileTypeRegistry }
      // Les modes du volet gauche deviennent des ecrans : rien a poser ici,
      // l'ecran monte ses vues quand on l'ouvre (expandPane).
      manager.setLeftPanelAdder(() => {}, viewCtx)
      // Vues revenues ou retirees (plugin, disposition) : on redessine.
      manager.setDockedPanelSyncer(refresh)
      setCtx(viewCtx)
      onReady?.(manager)
    })
    return () => { cancelled = true }
    // Une seule installation par montage, comme WorkspaceRoot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager])

  useEffect(() => {
    const update = () => setEditing(isEditable(document.activeElement))
    // focusout passe avant que le nouvel element ait le focus : on attend.
    const onFocusOut = () => { setTimeout(update, 0) }
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', onFocusOut)
    return () => { document.removeEventListener('focusin', update); document.removeEventListener('focusout', onFocusOut) }
  }, [])

  // Clavier ouvert : les boutons flottants de l'application (hors d'ici) se cachent.
  useEffect(() => {
    document.documentElement.classList.toggle('mobile-keyboard', keyboard)
    return () => { document.documentElement.classList.remove('mobile-keyboard') }
  }, [keyboard])

  // iOS ne retrecit pas la page quand le clavier s'ouvre : seule la partie
  // visible (visualViewport) retrecit. On cale alors l'interface sur elle,
  // pour que la barre d'edition reste juste au-dessus du clavier. Android
  // retrecit la page (interactive-widget) : rien a faire.
  const [visible, setVisible] = useState<{ top: number; height: number } | null>(null)
  useEffect(() => {
    const vv = window.visualViewport
    // Hauteur de reference sans clavier : la plus grande vue, pour cette largeur.
    let width = window.innerWidth
    let full = vv?.height ?? window.innerHeight
    const update = () => {
      const height = vv?.height ?? window.innerHeight
      if (window.innerWidth !== width) { width = window.innerWidth; full = height } // rotation
      full = Math.max(full, height)
      setShrunk(full - height > KEYBOARD_MIN)
      // iOS : la page garde sa taille, seule la partie visible retrecit.
      const covered = vv ? window.innerHeight - vv.height > KEYBOARD_MIN : false
      setVisible(covered && vv ? { top: vv.offsetTop, height: vv.height } : null)
    }
    vv?.addEventListener('resize', update)
    vv?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    update()
    return () => {
      vv?.removeEventListener('resize', update)
      vv?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  const screen = adapter.screen
  const sheet = adapter.sheetPanel
  visited.current.add(screen)
  if (sheet) visitedSheet.current.add(sheet)

  const editorTab: MobileTab = { id: EDITOR_SCREEN, title: t('layout', 'mobile.note'), icon: 'file-text' }
  const { primary, overflow } = bottomTabs(manager.getRibbonItems(), editorTab, 3, tabPriority)
  const sheetItems = ctx ? sheetTabs(manager.views) : []

  const screenTitle = (id: string): string => {
    if (id === EDITOR_SCREEN) return editorTitle || t('layout', 'mobile.note')
    if (id === MORE_SCREEN) return t('layout', 'mobile.more')
    return manager.views.getGroup(id)?.title ?? manager.views.get(id)?.title ?? ''
  }

  const back = () => {
    // Par l'historique : le retour du telephone et celui de la barre font pareil.
    if (adapter.canGoBack()) window.history.back()
  }

  const renderScreen = (id: string): ReactNode => {
    if (!ctx) return null
    if (id === MORE_SCREEN) {
      return (
        <div className="mobile-more">
          {overflow.length > 0 && (
            <nav className="mobile-list" aria-label={t('layout', 'mobile.more')}>
              {overflow.map(tab => (
                <button key={tab.id} type="button" className="mobile-list-item" onClick={() => adapter.navigate(tab.id)}>
                  <span className="mobile-list-icon">{renderIcon?.(tab.icon)}</span>
                  <span>{tab.title}</span>
                </button>
              ))}
            </nav>
          )}
          {more}
        </div>
      )
    }
    if (panelViews(manager.views, id).length === 0) return null
    return <PanelHost manager={manager} panelId={id} ctx={ctx} />
  }

  return (
    <WorkspaceContext.Provider value={manager}>
      <div
        className={['mobile-root', keyboard ? 'mobile-root--keyboard' : '', className].filter(Boolean).join(' ')}
        data-testid="mobile-workspace"
        data-screen={screen}
        style={visible ? { ...style, position: 'fixed', left: 0, right: 0, top: visible.top, height: visible.height, zIndex: 1 } : style}
      >
        <header className="mobile-topbar">
          {adapter.canGoBack() && !sheet ? (
            <button type="button" className="mobile-icon-btn" data-testid="mobile-back" aria-label={t('layout', 'mobile.back')} onClick={back}>
              <BackIcon />
            </button>
          ) : <span className="mobile-topbar-spacer" />}
          <h1 className="mobile-topbar-title" data-testid="mobile-title">{screenTitle(screen)}</h1>
          <div className="mobile-topbar-actions">
            {screen === EDITOR_SCREEN && editorActions}
            {sheetItems.length > 0 && (
              <button
                type="button"
                className="mobile-icon-btn"
                data-testid="mobile-sheet-open"
                aria-label={t('layout', 'mobile.panels')}
                onClick={() => { if (sheet) back(); else adapter.openSheet(sheetItems[0].id) }}
              >
                <PanelsIcon />
              </button>
            )}
          </div>
        </header>

        <main className="mobile-screens">
          {[...visited.current].map(id => (
            <div key={id} className="mobile-screen" data-screen-id={id} hidden={id !== screen}>
              {renderScreen(id)}
            </div>
          ))}
        </main>

        <nav className="mobile-tabbar" aria-label={t('layout', 'mobile.tabs')}>
          {[...primary, { id: MORE_SCREEN, title: t('layout', 'mobile.more'), icon: undefined }].map(tab => {
            const active = tab.id === screen || (tab.id === MORE_SCREEN && overflow.some(o => o.id === screen))
            return (
              <button
                key={tab.id}
                type="button"
                className={`mobile-tab${active ? ' mobile-tab--active' : ''}`}
                data-testid="mobile-tab"
                data-tab-id={tab.id}
                aria-current={active ? 'page' : undefined}
                onClick={() => adapter.navigate(tab.id)}
              >
                <span className="mobile-tab-icon">{tab.id === MORE_SCREEN ? <MoreIcon /> : renderIcon?.(tab.icon)}</span>
                <span className="mobile-tab-label">{tab.title}</span>
              </button>
            )
          })}
        </nav>

        {sheet && <div className="mobile-sheet-backdrop" onClick={back} />}
        <section className={`mobile-sheet${sheet ? ' mobile-sheet--open' : ''}`} data-testid="mobile-sheet" aria-hidden={!sheet}>
          <div className="mobile-sheet-grip" onClick={back} />
          {sheetItems.length > 1 && (
            <div className="mobile-chips" role="tablist">
              {sheetItems.map(tab => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={tab.id === sheet}
                  className={`mobile-chip${tab.id === sheet ? ' mobile-chip--active' : ''}`}
                  onClick={() => adapter.openSheet(tab.id)}
                >
                  {tab.title}
                </button>
              ))}
            </div>
          )}
          <div className="mobile-sheet-body">
            {ctx && [...visitedSheet.current].map(id => (
              <div key={id} className="mobile-sheet-panel" hidden={id !== sheet}>
                {panelViews(manager.views, id).length > 0 && <PanelHost manager={manager} panelId={id} ctx={ctx} />}
              </div>
            ))}
          </div>
        </section>
      </div>
    </WorkspaceContext.Provider>
  )
}
