// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Sur le telephone : une presentation est en cours sur un autre appareil du
// meme compte (proposition relayee par le serveur, plugin-api/slideRemote.ts).
// « Oui » ouvre la telecommande, comme le code QR ; « Non » ignore cette
// presentation. Le bandeau part seul quand la proposition n'arrive plus.
import { useEffect, useRef, useState } from 'react'
import { SLIDE_OFFER_TTL_MS, isSlideOffer, remotePath, type SlideOffer } from '@savoire/plugin-api'
import type { IMyDevices } from '@savoire/application'

type Seen = SlideOffer & { at: number }

const CSS = `
.so { position: fixed; left: 10px; right: 10px; top: calc(env(safe-area-inset-top) + 10px); z-index: 2147482000; display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; border-radius: 14px; background: #16181d; color: #ececec; box-shadow: 0 10px 34px rgba(0,0,0,.35); font-family: var(--font-ui, system-ui, sans-serif); animation: so-in .25s ease-out; }
@keyframes so-in { from { transform: translateY(-120%); opacity: 0 } to { transform: none; opacity: 1 } }
@media (prefers-reduced-motion: reduce) { .so { animation: none; } }
.so-head { font-size: 13px; color: #9aa0a6; }
.so-title { font-size: 16px; font-weight: 600; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.so-ask { font-size: 15px; }
.so-buttons { display: flex; gap: 8px; }
.so-btn { all: unset; flex: 1; text-align: center; padding: 12px 0; border-radius: 10px; font-size: 15px; font-weight: 600; background: #2a2e36; color: #fff; touch-action: manipulation; }
.so-btn-yes { flex: 2; background: var(--accent, #2563eb); }
`

/** Ecoute les propositions de presentation relayees aux appareils du compte, et les montre. */
export function SlideOfferBanner({ devices }: { devices: IMyDevices }) {
  const [offer, setOffer] = useState<Seen | null>(null)
  const declined = useRef(new Set<string>())

  useEffect(() => {
    const off = devices.onMessage(m => {
      if (!isSlideOffer(m)) return
      if (m.ended) { setOffer(o => (o?.session === m.session ? null : o)); return }
      if (declined.current.has(m.session)) return
      setOffer(o => (o?.session === m.session ? { ...o, title: m.title, at: Date.now() } : { ...m, at: Date.now() }))
    })
    const timer = setInterval(() => setOffer(o => (o && Date.now() - o.at > SLIDE_OFFER_TTL_MS ? null : o)), 1000)
    return () => { clearInterval(timer); off() }
  }, [devices])

  // Une nouvelle proposition : le telephone vibre.
  const session = offer?.session
  useEffect(() => { if (session) navigator.vibrate?.([30, 60, 30]) }, [session])

  if (!offer) return null
  const accept = () => window.location.assign(remotePath(offer.vaultId, offer.docId, offer.session))
  const refuse = () => { declined.current.add(offer.session); setOffer(null) }
  return (
    <div className="so" role="dialog" aria-label="Présentation en cours" data-testid="slide-offer">
      <style>{CSS}</style>
      <div className="so-head">Présentation en cours sur un autre appareil</div>
      <div className="so-title" data-testid="slide-offer-title">{offer.title}</div>
      <div className="so-ask">Voulez-vous être la télécommande ?</div>
      <div className="so-buttons">
        <button className="so-btn" data-testid="slide-offer-no" onClick={refuse}>Non</button>
        <button className="so-btn so-btn-yes" data-testid="slide-offer-yes" onClick={accept}>Oui, piloter</button>
      </div>
    </div>
  )
}
