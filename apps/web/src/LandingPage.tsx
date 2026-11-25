// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Page vitrine, pour les visiteurs non connectes (/decouvrir) : ce qu'est
// Savoire, ses ecrans, une galerie. Les images sont dans public/vitrine/,
// tirees des captures du vault de demo (docs/captures/).

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '@savoire/ui-components'
import { DesktopDownload } from './DesktopDownload'
import './landing.css'

const IMG = '/vitrine/'

interface Feature { title: string; text: string; points: string[]; image: string; alt: string }

const FEATURES: Feature[] = [
  {
    title: 'Des notes qui se répondent',
    text: 'Écrivez en Markdown, sans y penser. Un lien [[entre crochets]] relie deux idées, et chaque note montre celles qui la citent.',
    points: ['Propriétés, encadrés, tableaux, notes de bas de page', 'Trois façons d\'écrire : classique, rendu direct ou source', 'Import depuis Notion'],
    image: 'ecran-note-claire.webp',
    alt: 'Une note de projet avec ses propriétés, un encadré et un calendrier',
  },
  {
    title: 'Vos données en tableau ou en kanban',
    text: 'Une base, c\'est un dossier de notes. Chaque ligne reste une vraie note, que vous la voyiez en tableau, en kanban ou en liste.',
    points: ['Statuts colorés, dates, personnes, cases à cocher', 'Plusieurs vues sur les mêmes données', 'Tri, filtres et regroupements'],
    image: 'ecran-kanban.webp',
    alt: 'La roadmap d\'un produit en kanban, par statut',
  },
  {
    title: 'Voyez votre pensée prendre forme',
    text: 'Le graphe dessine les liens entre vos notes. Les sujets centraux ressortent, les idées isolées aussi.',
    points: ['Filtrer par dossier ou par étiquette', 'Ouvrir une note d\'un clic'],
    image: 'ecran-graphe.webp',
    alt: 'Le graphe des notes d\'un vault, reliées entre elles',
  },
  {
    title: 'Du croquis à la scène',
    text: 'Dessinez au tableau blanc, puis présentez sans changer d\'outil : une présentation est une note comme les autres.',
    points: ['Dessins Excalidraw dans le vault', 'Diapositives, transitions et animations', 'Télécommande sur le téléphone'],
    image: 'ecran-dessin.webp',
    alt: 'Un dessin Excalidraw du parcours d\'un utilisateur',
  },
]

const VALUES = [
  { icon: 'users', title: 'En temps réel', text: 'Écrivez à plusieurs dans la même note, chacun voit l\'autre.' },
  { icon: 'wifi-off', title: 'Hors ligne', text: 'Tout marche sans réseau. Les changements se rejoignent au retour.' },
  { icon: 'lock', title: 'Chez vous', text: 'Open source sous AGPL. Hébergez-le sur votre serveur si vous voulez.' },
  { icon: 'bot', title: 'Avec votre IA', text: 'Branchez ChatGPT ou Claude. Chaque agent n\'a que les droits donnés.' },
  { icon: 'puzzle', title: 'Extensible', text: 'Plugins, modèles et modules depuis le Store.' },
  { icon: 'globe', title: 'Partout', text: 'Dans le navigateur, ou en application pour Windows, macOS et Linux.' },
]

const GALLERY = [
  { file: 'visuel-hero.webp', title: 'Vos idées, enfin reliées' },
  { file: 'visuel-bases.webp', title: 'Tableau et kanban, une seule source' },
  { file: 'visuel-graphe.webp', title: 'Le graphe des notes' },
  { file: 'visuel-dessin-diapo.webp', title: 'Dessin et diapositive' },
  { file: 'visuel-themes.webp', title: 'Clair, sombre ou sépia' },
  { file: 'ecran-note-sombre.webp', title: 'Une note, thème sombre' },
  { file: 'ecran-tableau-sombre.webp', title: 'Une base en tableau' },
  { file: 'ecran-note-sepia.webp', title: 'Une note, thème sépia' },
  { file: 'ecran-diapositive.webp', title: 'Une diapositive' },
]

function Logo() {
  return (
    <svg width="112" height="32" viewBox="0 0 120 36" fill="none" aria-label="Savoire">
      <path d="M8 4 L3 9 L3 18 L3 27 L8 32" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
      <path d="M16 4 L11 9 L11 18 L11 27 L16 32" stroke="#2dd4bf" strokeWidth="2.8" strokeLinecap="round" />
      <text x="24" y="25" fontFamily="'Source Serif 4',Georgia,serif" fontSize="20" fontWeight="700" fill="currentColor" letterSpacing="-0.3">Savoire</text>
      <path d="M104 4 L109 9 L109 18 L109 27 L104 32" stroke="#2dd4bf" strokeWidth="2.8" strokeLinecap="round" />
      <path d="M112 4 L117 9 L117 18 L117 27 L112 32" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
    </svg>
  )
}

/** Une capture dans une fenetre de navigateur. */
function Shot({ src, alt, eager }: { src: string; alt: string; eager?: boolean }) {
  return (
    <figure className="lp-shot">
      <div className="lp-shot-bar" aria-hidden="true"><i /><i /><i /><span>savoire.app</span></div>
      <img src={IMG + src} alt={alt} loading={eager ? 'eager' : 'lazy'} width={1920} height={1200} />
    </figure>
  )
}

export function LandingPage() {
  const [open, setOpen] = useState<number | null>(null)
  const move = useCallback((d: number) => setOpen(i => i === null ? null : (i + d + GALLERY.length) % GALLERY.length), [])

  useEffect(() => {
    const previous = document.title
    document.title = 'Savoire · Vos idées, enfin reliées'
    return () => { document.title = previous }
  }, [])

  useEffect(() => {
    if (open === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null)
      else if (e.key === 'ArrowRight') move(1)
      else if (e.key === 'ArrowLeft') move(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, move])

  return (
    <div className="lp" data-testid="landing-page">
      <header className="lp-nav">
        <Link to="/decouvrir" className="lp-brand"><Logo /></Link>
        <nav>
          <a href="#presentation">Présentation</a>
          <a href="#galerie">Galerie</a>
          <Link to="/login" className="lp-btn lp-btn-small" data-testid="landing-login">Se connecter</Link>
        </nav>
      </header>

      <section className="lp-hero">
        <div className="lp-hero-text">
          <h1>Vos idées, <em>enfin reliées.</em></h1>
          <p>Notes, bases, dessins et présentations au même endroit. En temps réel, hors ligne, chez vous.</p>
          <div className="lp-actions">
            <Link to="/login" className="lp-btn" data-testid="landing-start">Commencer gratuitement</Link>
            <a href="#galerie" className="lp-btn lp-btn-ghost">Voir les écrans</a>
          </div>
          <ul className="lp-tags"><li>Markdown</li><li>Temps réel</li><li>Open source</li></ul>
        </div>
        <div className="lp-hero-shot"><Shot src="ecran-note-sombre.webp" alt="Savoire : une note de synthèse en thème sombre" eager /></div>
      </section>

      <section className="lp-values" aria-label="Les atouts de Savoire">
        {VALUES.map(v => (
          <div key={v.title} className="lp-value">
            <span className="lp-value-icon"><Icon name={v.icon} size={18} /></span>
            <h3>{v.title}</h3>
            <p>{v.text}</p>
          </div>
        ))}
      </section>

      <section id="presentation" className="lp-features">
        <h2 className="lp-section-title">Un seul outil pour penser, organiser et montrer</h2>
        {FEATURES.map((f, i) => (
          <article key={f.title} className={'lp-feature' + (i % 2 ? ' lp-feature-flip' : '')}>
            <div className="lp-feature-text">
              <h3>{f.title}</h3>
              <p>{f.text}</p>
              <ul>{f.points.map(p => <li key={p}><Icon name="check" size={16} />{p}</li>)}</ul>
            </div>
            <Shot src={f.image} alt={f.alt} />
          </article>
        ))}
      </section>

      <section id="galerie" className="lp-gallery">
        <h2 className="lp-section-title">Galerie</h2>
        <p className="lp-section-sub">Des écrans réels, pris dans un vault de démonstration.</p>
        <div className="lp-grid">
          {GALLERY.map((g, i) => (
            <button key={g.file} type="button" className="lp-thumb" onClick={() => setOpen(i)} data-testid="landing-gallery-item">
              <img src={IMG + g.file} alt={g.title} loading="lazy" />
              <span>{g.title}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="lp-cta">
        <h2>Prêt à relier vos idées ?</h2>
        <p>Créez un compte en une minute, ou installez Savoire sur votre propre serveur.</p>
        <div className="lp-actions lp-actions-center">
          <Link to="/login" className="lp-btn lp-btn-light">Commencer</Link>
          <a href="https://github.com/JleloupDev/Savoire" className="lp-btn lp-btn-ghost" target="_blank" rel="noopener noreferrer">Code source</a>
        </div>
        <div className="lp-download"><DesktopDownload /></div>
      </section>

      <footer className="lp-footer">
        <Logo />
        <span>AGPL-3.0 · Open source · Auto-hébergeable</span>
      </footer>

      {open !== null && (
        <div className="lp-lightbox" role="dialog" aria-modal="true" aria-label={GALLERY[open].title} onClick={() => setOpen(null)}>
          <img src={IMG + GALLERY[open].file} alt={GALLERY[open].title} onClick={e => e.stopPropagation()} />
          <div className="lp-lightbox-bar" onClick={e => e.stopPropagation()}>
            <span>{GALLERY[open].title}</span>
            <div>
              <button type="button" onClick={() => move(-1)} aria-label="Image précédente"><Icon name="chevron-left" size={18} /></button>
              <button type="button" onClick={() => move(1)} aria-label="Image suivante"><Icon name="chevron-right" size={18} /></button>
              <button type="button" onClick={() => setOpen(null)} aria-label="Fermer"><Icon name="x" size={18} /></button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
