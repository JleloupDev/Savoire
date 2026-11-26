// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Page vitrine, pour les visiteurs non connectes (/decouvrir) : ce qu'est
// Savoire, les formats qu'il reunit, ses ecrans, une galerie. Style
// editorial (maquette « Inspire d'Anytype », 26/11/2026) : fond blanc,
// filets noirs, Newsreader et Inter en maigre. Images dans public/vitrine/,
// tirees des captures du vault de demo (docs/captures/).

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '@savoire/ui-components'
import { DesktopDownload } from './DesktopDownload'
import './landing.css'

const IMG = '/vitrine/'

const WORDS = ['Vos idées,', 'Vos notes,', 'Vos présentations,', 'Vos cartes mentales,', 'Vos bases,']

/** Les formats autour de Savoire : nom, extension, position sur le cercle. */
const FORMATS: Array<[string, string, number, number]> = [
  ['Word', '.docx', 50, 12],
  ['PowerPoint', '.pptx', 79.7, 26.3],
  ['Carte mentale', 'mindmap', 87, 58.5],
  ['PDF', '.pdf', 66.5, 84.2],
  ['Markdown', '.md', 33.5, 84.2],
  ['Dessin', '.excalidraw', 13, 58.5],
  ['Base', 'tableau, kanban', 20.3, 26.3],
]

const BAND = ['Word', 'PowerPoint', 'Carte mentale', 'PDF', 'Markdown', 'Dessin', 'Diapositives', 'Tableau', 'Kanban', 'Graphe']

const VALUES = [
  { title: 'En temps réel', text: 'Écrivez à plusieurs dans la même note, chacun voit l\'autre.' },
  { title: 'Hors ligne', text: 'Tout marche sans réseau. Les changements se rejoignent au retour.' },
  { title: 'Chez vous', text: 'Open source sous AGPL. Hébergez-le sur votre serveur si vous voulez.' },
  { title: 'Avec votre IA', text: 'Branchez ChatGPT ou Claude. Chaque agent n\'a que les droits donnés.' },
  { title: 'Extensible', text: 'Plugins, modèles et modules depuis le Store.' },
  { title: 'Partout', text: 'Dans le navigateur, ou en application pour Windows, macOS et Linux.' },
]

const FEATURES = [
  {
    title: 'Des notes qui se répondent',
    text: 'Écrivez en Markdown, sans y penser. Un lien [[entre crochets]] relie deux idées, et chaque note montre celles qui la citent.',
    points: ['Propriétés, encadrés, tableaux, notes de bas de page', 'Trois façons d\'écrire : classique, rendu direct ou source', 'Import depuis Notion'],
    image: 'ecran-note-sombre.webp',
    alt: 'Une note de synthèse en thème sombre',
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

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** Les debuts de titre qui se relaient au-dessus de « enfin reliees. ». */
function RotatingWords() {
  const [i, setI] = useState(0)
  useEffect(() => {
    if (reducedMotion()) return
    const timer = setInterval(() => setI(n => n + 1), 2400)
    return () => clearInterval(timer)
  }, [])
  const cur = i % WORDS.length
  return (
    <span className="lp-words">
      {WORDS.map((w, k) => (
        <span key={w} aria-hidden={k !== cur} className={k === cur ? 'on' : k < cur ? 'before' : 'after'}>{w}</span>
      ))}
    </span>
  )
}

export function LandingPage() {
  const [open, setOpen] = useState<number | null>(null)
  const move = useCallback((d: number) => setOpen(i => i === null ? null : (i + d + GALLERY.length) % GALLERY.length), [])

  useEffect(() => {
    const previous = document.title
    document.title = 'Savoire, tous vos documents réunis'
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
      <div className="lp-frame">
        <header className="lp-nav">
          <Link to="/decouvrir" className="lp-brand">savoire</Link>
          <nav>
            <a href="#formats">Formats</a>
            <a href="#galerie">Galerie</a>
            <Link to="/login" className="lp-pill" data-testid="landing-login">Se connecter</Link>
          </nav>
        </header>

        <section className="lp-hero">
          <h1>
            <RotatingWords />
            <span className="lp-serif">enfin reliées.</span>
          </h1>
          <p>Notes, bases, dessins et présentations au même endroit. En temps réel, hors ligne, chez vous.</p>
          <div className="lp-actions">
            <Link to="/login" className="lp-btn lp-lift" data-testid="landing-start">Commencer gratuitement</Link>
            <a href="#formats" className="lp-btn lp-btn-ghost lp-lift">Voir les formats</a>
          </div>
          <p className="lp-kicker">Markdown · Temps réel · Open source</p>
        </section>

        <div className="lp-hero-shot lp-reveal">
          <img src={IMG + 'ecran-note-claire.webp'} alt="Une note de projet avec ses propriétés, un encadré et un calendrier" width={1920} height={1200} />
        </div>

        <div className="lp-band" aria-hidden="true">
          <div className="lp-track">
            {[...BAND, ...BAND].map((b, k) => <span key={k}>{b} <i>·</i></span>)}
          </div>
        </div>

        <section id="formats" className="lp-formats">
          <h2 className="lp-reveal">Tous vos documents,<br />réunis et reliés.</h2>
          <p className="lp-lead lp-reveal">
            PowerPoint, Word, cartes mentales, PDF : chaque document a sa place dans Savoire, et un lien <code>[[entre crochets]]</code> le relie à tous les autres.
          </p>
          <div className="lp-orbit">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <g className="lp-flow">
                {FORMATS.map(([name, , x, y]) => (
                  <line key={name} x1="50" y1="50" x2={x} y2={y} vectorEffect="non-scaling-stroke" />
                ))}
              </g>
            </svg>
            <div className="lp-hub">savoire</div>
            {FORMATS.map(([name, ext, x, y], k) => (
              <div key={name} className="lp-tile" style={{ left: `${x}%`, top: `${y}%`, animationDelay: `${k * -0.8}s` }}>
                <svg width="26" height="32" viewBox="0 0 26 32" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M1 1h16l8 8v22H1z" /><path d="M17 1v8h8" /></svg>
                <span><b>{name}</b><small>{ext}</small></span>
              </div>
            ))}
          </div>
        </section>

        <section className="lp-values" aria-label="Les atouts de Savoire">
          {VALUES.map(v => (
            <div key={v.title}>
              <h3>{v.title}</h3>
              <p>{v.text}</p>
            </div>
          ))}
        </section>

        <h2 id="presentation" className="lp-big lp-reveal">Un seul outil pour penser,<br />organiser et montrer</h2>

        <section className="lp-features">
          {FEATURES.map(f => (
            <article key={f.title} className="lp-reveal">
              <h3>{f.title}</h3>
              <p>{f.text}</p>
              <p className="lp-points">{f.points.join('  ·  ')}</p>
              <div className="lp-shot lp-lift">
                <img src={IMG + f.image} alt={f.alt} loading="lazy" width={1920} height={1200} />
              </div>
            </article>
          ))}
        </section>

        <section id="galerie" className="lp-gallery">
          <h2>Galerie</h2>
          <p className="lp-sub">Des écrans réels, pris dans un vault de démonstration.</p>
          <div className="lp-grid">
            {GALLERY.map((g, i) => (
              <figure key={g.file} className="lp-reveal">
                <button type="button" className="lp-zoom" onClick={() => setOpen(i)} data-testid="landing-gallery-item" aria-label={`Agrandir : ${g.title}`}>
                  <img src={IMG + g.file} alt={g.title} loading="lazy" />
                </button>
                <figcaption>{g.title}</figcaption>
              </figure>
            ))}
          </div>
        </section>

        <section className="lp-cta">
          <h2 className="lp-reveal">Prêt à relier vos idées ?</h2>
          <p>Créez un compte en une minute, ou installez Savoire sur votre propre serveur.</p>
          <div className="lp-actions">
            <Link to="/login" className="lp-btn lp-lift">Commencer</Link>
            <a href="https://github.com/JleloupDev/Savoire" className="lp-btn lp-btn-ghost lp-lift" target="_blank" rel="noopener noreferrer">Code source</a>
          </div>
          <div className="lp-download"><DesktopDownload /></div>
        </section>

        <footer className="lp-footer">
          <span>savoire</span><span>AGPL-3.0 · Open source · Auto-hébergeable</span>
        </footer>
      </div>

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
