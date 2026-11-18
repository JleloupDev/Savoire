// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'ecran « Plus » de l'interface mobile : ce que le bureau range dans la
// barre d'icones (reglages, compte) et dans la barre du haut (langue).
// L'administration et les outils de debug restent sur le bureau.

import { Icon } from '@savoire/ui-components'
import type { AccountEntry } from './types'

export interface MobileMoreProps {
  onQuickOpen: () => void
  onSettings: () => void
  /** Absent : le vault ouvert ne se partage pas (profil sans arbitre). */
  onShare?: () => void
  locale: string
  onToggleLocale: () => void
  accounts: AccountEntry[]
  activeAccount: AccountEntry | null
  onSwitchAccount: (account: AccountEntry) => void
  /** Absent : profil a cle utilisateur seulement. */
  onManageKey?: () => void
  /** Version bureau dans une petite fenetre : le serveur et son compte. */
  onOpenServer?: () => void
  /** Absent : compte local, rien a deconnecter. */
  onLogout?: () => void
}

function Item({ icon, label, note, danger, onClick, testId }: { icon: string; label: string; note?: string; danger?: boolean; onClick: () => void; testId?: string }) {
  return (
    <button type="button" className={`mobile-list-item${danger ? ' mobile-list-item--danger' : ''}`} onClick={onClick} data-testid={testId}>
      <span className="mobile-list-icon"><Icon name={icon} size={18} /></span>
      <span>{label}</span>
      {note && <span className="mobile-list-note">{note}</span>}
    </button>
  )
}

export function MobileMore(props: MobileMoreProps) {
  const others = props.accounts.filter(a => a.userId !== props.activeAccount?.userId)
  return (
    <div data-testid="mobile-more">
      <div className="mobile-list-head">Vault</div>
      <nav className="mobile-list">
        <Item icon="search" label="Ouverture rapide" onClick={props.onQuickOpen} testId="mobile-quick-open" />
        {props.onShare && <Item icon="share-2" label="Partager" onClick={props.onShare} />}
      </nav>

      <div className="mobile-list-head">Application</div>
      <nav className="mobile-list">
        <Item icon="settings" label="Paramètres" onClick={props.onSettings} testId="settings-open" />
        <Item icon="globe" label={props.locale === 'fr' ? 'Langue' : 'Language'} note={props.locale === 'fr' ? 'Français' : 'English'} onClick={props.onToggleLocale} />
      </nav>

      <div className="mobile-list-head">Compte</div>
      <nav className="mobile-list">
        {props.activeAccount && (
          <div className="mobile-list-item" style={{ cursor: 'default' }}>
            <span className="mobile-list-icon"><Icon name="user" size={18} /></span>
            <span>{props.activeAccount.displayName}</span>
            <span className="mobile-list-note">{props.activeAccount.email}</span>
          </div>
        )}
        {others.map(account => (
          <Item key={account.userId} icon="users" label={`Passer à ${account.displayName}`} onClick={() => props.onSwitchAccount(account)} />
        ))}
        {props.onOpenServer && <Item icon="cloud" label="Serveur et compte…" onClick={props.onOpenServer} />}
        {props.onManageKey && <Item icon="lock" label="Ma clé de chiffrement" onClick={props.onManageKey} />}
        {props.onLogout && <Item icon="log-out" label="Déconnexion" danger onClick={props.onLogout} />}
      </nav>
    </div>
  )
}
