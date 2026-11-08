// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Icones de la barre de gauche : les plugins donnent un nom Lucide
// (« files », « search »), dessine par Icon (ui-components).
import { Icon } from '@savoire/ui-components'

export function RibbonIcon({ name }: { name?: string }) {
  return <Icon name={name || 'square'} size={18} />
}

export function SettingsIcon() {
  return <Icon name="settings" size={18} />
}

export function RailLogoSvg() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
      <path d="M5 2 L2 5 L2 10 L2 15 L5 18" stroke="rgba(255,255,255,0.75)" strokeWidth="2.2" strokeLinecap="round"/>
      <path d="M9 2 L6 5 L6 10 L6 15 L9 18" stroke="rgba(255,255,255,0.55)" strokeWidth="2.2" strokeLinecap="round"/>
      <path d="M15 2 L18 5 L18 10 L18 15 L15 18" stroke="rgba(255,255,255,0.75)" strokeWidth="2.2" strokeLinecap="round"/>
      <path d="M11 2 L14 5 L14 10 L14 15 L11 18" stroke="rgba(255,255,255,0.55)" strokeWidth="2.2" strokeLinecap="round"/>
    </svg>
  )
}
