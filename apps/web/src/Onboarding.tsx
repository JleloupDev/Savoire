// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Fenetre d'accueil de la premiere visite. Deux questions : d'ou vient la
// personne (Obsidian, Notion), puis la confirmation du type de fichier par
// defaut (Markdown ou pages). Voir onboardingPreferences.ts.
import { useState } from 'react'
import { applyOnboarding, markOnboardingDone, SUGGESTED_FILE_TYPE, type OnboardingOrigin } from './onboardingPreferences'

const small: React.CSSProperties = { color: 'var(--text-muted)', fontSize: '0.8rem', lineHeight: 1.45 }

const ORIGINS: { id: OnboardingOrigin; name: string; description: string }[] = [
  { id: 'obsidian', name: 'Obsidian', description: 'Des notes Markdown, reliées entre elles.' },
  { id: 'notion', name: 'Notion', description: 'Des pages faites de blocs, rangées les unes dans les autres.' },
  { id: 'other', name: 'Ni l’un ni l’autre', description: 'Je découvre Savoire.' },
]

const FILE_TYPE_NAME: Record<'md' | 'page', string> = { md: 'le Markdown', page: 'les pages' }

/** La confirmation du type de fichier, selon l'origine choisie. */
function confirmation(origin: OnboardingOrigin): { question: string; detail: string } {
  if (origin === 'obsidian') return {
    question: 'Souhaitez-vous que votre type de fichier par défaut soit le Markdown ?',
    detail: 'Chaque nouvelle note sera un fichier .md, comme dans Obsidian.',
  }
  if (origin === 'notion') return {
    question: 'Souhaitez-vous que votre type de fichier par défaut soit la page, comme dans Notion ?',
    detail: 'Chaque nouvelle note sera une page faite de blocs, avec ses sous-pages.',
  }
  return {
    question: 'Quel type de fichier souhaitez-vous par défaut ?',
    detail: 'Le Markdown : du texte simple, lisible partout. Les pages : des blocs, comme dans Notion.',
  }
}

function button(primary: boolean): React.CSSProperties {
  return {
    padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600, fontFamily: 'var(--font-ui)',
    border: primary ? '1px solid var(--accent)' : '1px solid var(--border)',
    background: primary ? 'var(--accent)' : 'transparent',
    color: primary ? 'var(--accent-text, #fff)' : 'var(--text)',
  }
}

const link: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '0.78rem',
  color: 'var(--text-faint)', fontFamily: 'var(--font-ui)', textDecoration: 'underline',
}

/**
 * `onDone(applied)` : les reponses sont posees (applied), ou l'accueil a ete
 * passe (les reglages de depart restent).
 */
export function Onboarding({ onDone }: { onDone(applied: boolean): void }) {
  const [origin, setOrigin] = useState<OnboardingOrigin | null>(null)

  function finish(fileType: string) {
    if (!origin) return
    applyOnboarding(origin, fileType)
    onDone(true)
  }

  function skip() {
    markOnboardingDone()
    onDone(false)
  }

  const suggested = origin ? SUGGESTED_FILE_TYPE[origin] : 'md'
  const other = suggested === 'md' ? 'page' : 'md'
  const text = origin ? confirmation(origin) : null

  return (
    <div data-testid="onboarding" className="sv-overlay" style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div role="dialog" aria-modal="true" aria-labelledby="onboarding-title" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.24)', width: 560, maxWidth: '92vw', padding: '28px 30px 22px', color: 'var(--text)', fontFamily: 'var(--font-ui)' }}>
        {!origin || !text ? (
          <div data-testid="onboarding-origin">
            <div id="onboarding-title" style={{ fontSize: '1.2rem', fontWeight: 700 }}>Bienvenue dans Savoire</div>
            <div style={{ ...small, marginTop: 6 }}>Deux questions, et l’application se règle pour vous.</div>
            <div style={{ fontWeight: 600, marginTop: 22, marginBottom: 10 }}>Vous venez de Notion ou d’Obsidian ?</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {ORIGINS.map(o => (
                <button key={o.id} type="button" data-testid="onboarding-origin-choice" data-origin={o.id} onClick={() => setOrigin(o.id)}
                  style={{ textAlign: 'left', padding: '10px 14px', borderRadius: 10, cursor: 'pointer', border: '2px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text)', fontFamily: 'var(--font-ui)' }}>
                  <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>{o.name}</div>
                  <div style={{ ...small, marginTop: 2 }}>{o.description}</div>
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
              <button type="button" data-testid="onboarding-skip" onClick={skip} style={link}>Passer</button>
            </div>
          </div>
        ) : (
          <div data-testid="onboarding-confirm" data-origin={origin}>
            <div id="onboarding-title" style={{ fontSize: '1.05rem', fontWeight: 700, lineHeight: 1.4 }}>{text.question}</div>
            <div style={{ ...small, marginTop: 8 }}>{text.detail}</div>
            <div style={{ ...small, marginTop: 8 }}>
              Les autres types (dessins, cartes, bases…) restent dans « Autres types de fichiers » et dans le menu « / ».
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 22, flexWrap: 'wrap' }}>
              {origin === 'other' ? (
                <>
                  <button type="button" data-testid="onboarding-file-type" data-extension="md" onClick={() => finish('md')} style={button(true)}>Le Markdown</button>
                  <button type="button" data-testid="onboarding-file-type" data-extension="page" onClick={() => finish('page')} style={button(false)}>Les pages</button>
                </>
              ) : (
                <>
                  <button type="button" data-testid="onboarding-file-type" data-extension={suggested} onClick={() => finish(suggested)} style={button(true)}>Oui, {FILE_TYPE_NAME[suggested]}</button>
                  <button type="button" data-testid="onboarding-file-type" data-extension={other} onClick={() => finish(other)} style={button(false)}>Non, plutôt {FILE_TYPE_NAME[other]}</button>
                </>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 18 }}>
              <button type="button" data-testid="onboarding-back" onClick={() => setOrigin(null)} style={link}>Retour</button>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>Tout reste modifiable dans Options › Apparence › Disposition.</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
