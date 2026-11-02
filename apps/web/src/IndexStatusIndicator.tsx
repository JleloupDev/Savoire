// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Indicateur discret de l'etat de l'index du vault ouvert (ADR-027) : pret,
// en construction (63 %), en retard, indisponible (mode degrade : recherche
// limitee aux notes ouvertes). L'explication est au survol ; un clic relance
// le pair indexeur quand il ne repond pas.
import { useEffect, useState } from 'react'
import type { IndexerIndicatorState, IndexerServices } from './indexerServices'

interface View {
  label: string
  color: string
  title: string
  status: string
}

function seconds(at: number | undefined): string {
  if (!at) return ''
  const s = Math.max(0, Math.round((at - Date.now()) / 1000))
  return s > 0 ? ` Nouvel essai dans ${s} s.` : ''
}

const DEGRADED = 'Mode dégradé : la recherche est limitée aux notes ouvertes, les bases aux notes déjà indexées. L\'édition n\'est pas touchée.'

/** Texte, couleur et explication de l'etat ; null : rien a montrer. */
export function describeIndicator(s: IndexerIndicatorState): View | null {
  if (s.source === 'none') return null
  const st = s.state
  const r = s.remote
  const who = s.source === 'remote' ? 'Pair indexeur' : 'Index local'
  switch (st.status) {
    case 'building': {
      const pct = st.progress !== undefined ? ` ${Math.round(st.progress * 100)} %` : ''
      return { status: 'building', label: `Index en construction${pct}`, color: 'var(--color-info, #2563eb)',
        title: `${who} : construction de l'index du vault${pct}. Les résultats sont partiels en attendant.` }
    }
    case 'lagging':
      return r?.reason === 'busy'
        ? { status: 'lagging', label: 'Index freiné', color: 'var(--color-warning, #b45309)',
          title: `Pair indexeur surchargé : trop de demandes. Les requêtes reprennent bientôt ; en attendant, l'index local répond.${seconds(r.retryAt)}` }
        : { status: 'lagging', label: 'Index en retard', color: 'var(--color-warning, #b45309)',
          title: `${who} : en retard sur les dernières modifications${st.lagMs ? ` (${Math.round(st.lagMs / 1000)} s)` : ''}. Elles arrivent.` }
    case 'unavailable': {
      if (s.source === 'local') {
        return { status: 'unavailable', label: 'Index limité', color: 'var(--text-faint, #888)',
          title: `Pas d'index complet pour ce vault. ${DEGRADED}` }
      }
      let why = 'Le pair indexeur ne répond pas.'
      if (r?.reason === 'none') why = 'Ce vault n\'a pas de pair indexeur (réglage du vault, par son propriétaire).'
      else if (r?.reason === 'organization') why = `Ce vault est servi par le pair indexeur de son organisation${r.url ? ` (${r.url})` : ''} : ce circuit n'est pas encore disponible dans l'appli.`
      else if (r?.reason === 'denied') why = 'Accès au pair indexeur refusé.'
      const retry = r?.reason === 'down' ? `${seconds(r.retryAt)} Cliquez pour réessayer maintenant.` : ''
      return { status: 'unavailable', label: 'Index indisponible', color: 'var(--color-danger, #dc2626)', title: `${why} ${DEGRADED}${retry}` }
    }
    default:
      if (s.source === 'local') return null
      if (r && r.pending > 0) {
        return { status: 'pending', label: 'Index : mise à jour…', color: 'var(--color-info, #2563eb)',
          title: `Pair indexeur prêt. ${r.pending === 1 ? 'Votre dernière modification sera' : `Vos ${r.pending} dernières modifications seront`} dans les résultats dans quelques secondes.` }
      }
      return { status: 'ready', label: 'Index prêt', color: 'var(--color-success, #15803d)',
        title: `Pair indexeur prêt : recherche, bases, liens et tags couvrent tout le vault${r?.docs !== undefined ? ` (${r.docs} notes indexées)` : ''}.` }
  }
}

export function IndexStatusIndicator({ services }: { services: IndexerServices }) {
  const [state, setState] = useState<IndexerIndicatorState>(() => services.indicator())
  const [, setTick] = useState(0)
  useEffect(() => {
    setState(services.indicator())
    return services.subscribe(setState)
  }, [services])
  // Compte a rebours du prochain essai, au survol comme a l'ecran.
  useEffect(() => {
    if (!state.remote?.retryAt) return
    const t = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [state.remote?.retryAt])

  const view = describeIndicator(state)
  if (!view) return null
  const canRetry = state.source === 'remote' && view.status === 'unavailable' && state.remote?.reason === 'down'
  return (
    <span
      data-testid="index-indicator"
      data-status={view.status}
      title={view.title}
      onClick={canRetry ? () => void services.vaultIndexer?.refreshNow() : undefined}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-faint)',
        whiteSpace: 'nowrap', cursor: canRetry ? 'pointer' : 'default', userSelect: 'none',
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: view.color, flexShrink: 0 }} />
      {view.label}
    </span>
  )
}
