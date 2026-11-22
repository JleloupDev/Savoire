// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Dictee : parler, et le texte s'ecrit dans la note, au curseur.
//
// Deux sources, choisies dans Parametres → IA → Dictee :
//  - 'browser'    : la reconnaissance vocale du navigateur (Chrome, Edge,
//                   Safari). Sans cle ; le texte arrive phrase par phrase.
//                   Le navigateur peut envoyer le son a son editeur (Google,
//                   Apple, Microsoft) : ce n'est pas « local ».
//  - 'connection' : une connexion IA de la personne qui parle l'API de
//                   transcription d'OpenAI (OpenAI, ou un service sur ce
//                   poste : whisper.cpp, Speaches...). Le son est coupe a
//                   chaque pause (SilenceSegmenter) : le texte arrive au fil
//                   de la parole, morceau par morceau, dans l'ordre.
//
// Pendant la dictee, une barre en bas de l'ecran montre qu'on ecoute, le
// texte provisoire (navigateur) ou la transcription en cours, et un bouton
// pour arreter : le micro de la barre d'outils peut etre replie dans « ⋯ ».
//
// La reconnaissance du navigateur ne marche pas partout (application de
// bureau, Brave, Firefox) : sur une erreur de service, on passe a la
// connexion IA s'il y en a une, et on le retient.
import { notify } from '@savoire/notifications'
import { aiAccount, aiService } from './aiService'
import { isTauriRuntime } from './tauriRuntime'

export type DictationSource = 'browser' | 'connection'

export interface DictationSettings {
  source: DictationSource
  /** Connexion IA (source 'connection') ; absente : celle par defaut. */
  connectionId?: string
  /** Modele de transcription (source 'connection'). */
  model: string
  /** Langue parlee (code ISO : fr, en...). */
  language: string
}

export const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe'
/** Un enregistrement s'arrete seul au bout de 10 minutes (limite de taille des services). */
const MAX_RECORDING_MS = 10 * 60 * 1000

/** Ce qu'il faut de l'editeur (CodeMirror) : le curseur, et ecrire. */
interface DictationView {
  state: { selection: { main: { from: number; to: number } }; doc: { length: number; sliceString(from: number, to: number): string } }
  dispatch(tr: { changes?: { from: number; to: number; insert: string }; selection?: { anchor: number }; scrollIntoView?: boolean; userEvent?: string }): void
  focus?(): void
}

type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void; stop(): void
}

function recognitionClass(): (new () => Recognition) | undefined {
  const w = (typeof window !== 'undefined' ? window : {}) as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

/** La reconnaissance du navigateur existe-t-elle ici ? */
export function browserDictationAvailable(): boolean {
  return !!recognitionClass()
}

const key = () => `savoire-dictation:${aiAccount()}`

export function loadDictationSettings(): DictationSettings {
  // Bureau : la reconnaissance de la vue web n'est pas fiable ; une connexion IA d'abord.
  const preferConnection = aiService.connections().length > 0 && (!browserDictationAvailable() || isTauriRuntime())
  const fallback: DictationSettings = {
    source: preferConnection ? 'connection' : 'browser',
    model: DEFAULT_TRANSCRIPTION_MODEL,
    language: 'fr',
  }
  try {
    const saved = JSON.parse(localStorage.getItem(key()) ?? 'null') as Partial<DictationSettings> | null
    return saved ? { ...fallback, ...saved } : fallback
  } catch {
    return fallback
  }
}

/** La connexion qui transcrit : celle choisie, sinon (absente ou supprimee) celle par defaut. */
export function dictationConnection(s: DictationSettings): { id: string; name: string; model: string } | undefined {
  const all = aiService.connections()
  return all.find(c => c.id === s.connectionId) ?? all.find(c => c.isDefault) ?? all[0]
}

/** Ce qui transcrit, en clair (reglages, barre de dictee). */
export function dictationSourceLabel(s: DictationSettings): string {
  if (s.source === 'browser') return 'le navigateur'
  const c = dictationConnection(s)
  return c ? `${c.name} (${s.model || DEFAULT_TRANSCRIPTION_MODEL})` : 'aucune connexion IA'
}

export function saveDictationSettings(s: DictationSettings): void {
  try { localStorage.setItem(key(), JSON.stringify(s)) } catch { /* stockage indisponible */ }
}

/** Ecrit au curseur, avec une espace si le texte d'avant n'en finit pas par une. */
export function insertDictated(view: DictationView, text: string): void {
  const t = text.trim()
  if (!t) return
  const { from, to } = view.state.selection.main
  const before = from > 0 ? view.state.doc.sliceString(from - 1, from) : ''
  const insert = `${before && !/\s/.test(before) ? ' ' : ''}${t}`
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, scrollIntoView: true, userEvent: 'input.dictation' })
}

/**
 * Coupe un enregistrement aux pauses : on lui donne le volume (RMS) toutes
 * les ~100 ms ; il dit quand couper (une pause apres de la parole, ou un
 * morceau trop long). Le seuil suit le bruit de fond.
 */
export class SilenceSegmenter {
  private noise = 0.005
  private voiced = false
  private lastVoice = 0
  private start: number

  constructor(now: number, private readonly opts: { pauseMs?: number; minMs?: number; maxMs?: number } = {}) {
    this.start = now
  }

  /** Il y a eu de la parole dans le morceau en cours. */
  get hasVoice(): boolean {
    return this.voiced
  }

  /** Un nouveau morceau commence. */
  reset(now: number): void {
    this.start = now
    this.voiced = false
  }

  /** Le volume a l'instant `now` ; true : couper ici. */
  feed(rms: number, now: number): boolean {
    const threshold = Math.max(0.012, this.noise * 3)
    if (rms > threshold) { this.voiced = true; this.lastVoice = now }
    // Le bruit de fond se mesure dans le silence (moyenne lente).
    else this.noise = this.noise * 0.95 + rms * 0.05
    const length = now - this.start
    if (length >= (this.opts.maxMs ?? 25_000)) return this.voiced
    return this.voiced && length >= (this.opts.minMs ?? 1200) && now - this.lastVoice >= (this.opts.pauseMs ?? 900)
  }
}

/** La barre de dictee, en bas de l'ecran. */
class DictationBar {
  private el: HTMLElement | null = null
  private text: HTMLElement | null = null

  show(state: { label: string; interim?: string; busy?: boolean }, onStop: () => void): void {
    if (typeof document === 'undefined') return
    if (!this.el) {
      const el = document.createElement('div')
      el.className = 'dictation-bar'
      el.setAttribute('data-testid', 'dictation-bar')
      el.setAttribute('role', 'status')
      const dot = document.createElement('span')
      dot.className = 'dictation-bar-dot'
      const text = document.createElement('span')
      text.className = 'dictation-bar-text'
      const stop = document.createElement('button')
      stop.type = 'button'
      stop.className = 'dictation-bar-stop'
      stop.textContent = 'Arrêter'
      stop.setAttribute('data-testid', 'dictation-stop')
      stop.addEventListener('mousedown', e => e.preventDefault())
      stop.addEventListener('click', () => this.onStop?.())
      el.append(dot, text, stop)
      document.body.appendChild(el)
      this.el = el
      this.text = text
    }
    this.onStop = onStop
    this.el.classList.toggle('is-busy', !!state.busy)
    this.text!.textContent = state.interim ? `${state.label} « ${state.interim} »` : state.label
  }

  private onStop: (() => void) | null = null

  hide(): void {
    this.el?.remove()
    this.el = null
    this.text = null
  }
}

class Dictation {
  private stopFn: (() => void) | null = null
  private readonly listeners = new Set<() => void>()
  /** Transcriptions en cours (source 'connection'). */
  private pending = 0
  private readonly bar = new DictationBar()
  /** Texte provisoire (navigateur), montre dans la barre. */
  private interim = ''
  private source: DictationSource = 'browser'
  /** Qui transcrit, montre dans la barre. */
  private by = ''

  get busy(): boolean {
    return this.pending > 0
  }

  get active(): boolean {
    return this.stopFn !== null
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  /** L'editeur ou l'on dicte : une transaction vide redessine sa barre (bouton micro allume). */
  private view: DictationView | null = null

  private emit(): void {
    try { this.view?.dispatch({}) } catch { /* editeur ferme */ }
    if (this.active || this.pending > 0) {
      const by = this.by ? ` · ${this.by}` : ''
      const label = this.active
        ? (this.source === 'browser' ? `🎙 J’écoute${by}…` : this.pending > 0 ? `🎙 J’écoute${by}… (transcription en cours)` : `🎙 J’écoute${by}… le texte arrive à chaque pause`)
        : `Transcription${by}…`
      this.bar.show({ label, ...(this.interim ? { interim: this.interim } : {}), busy: this.pending > 0 }, () => this.stop())
    } else {
      this.bar.hide()
    }
    for (const cb of this.listeners) cb()
  }

  /** Demarre, ou arrete si elle tourne deja. */
  toggle(view: unknown): void {
    if (this.stopFn) { this.stop(); return }
    const v = view as DictationView | null | undefined
    if (!v?.dispatch || !v.state?.selection) { notify('warn', 'Dictée', 'Placez le curseur dans une note.'); return }
    this.view = v
    const s = loadDictationSettings()
    if (s.source === 'browser') this.startBrowser(v, s)
    else void this.startRecording(v, s)
  }

  stop(): void {
    const f = this.stopFn
    this.stopFn = null
    this.interim = ''
    f?.()
    this.emit()
  }

  private startBrowser(view: DictationView, s: DictationSettings): void {
    const R = recognitionClass()
    if (!R) {
      if (this.fallBack(view, s, 'Ce navigateur ne sait pas dicter.')) return
      notify('warn', 'Dictée', 'Ce navigateur ne sait pas dicter. Choisissez une connexion IA dans Paramètres → IA → Dictée.')
      return
    }
    this.source = 'browser'
    this.by = 'navigateur'
    const rec = new R()
    rec.lang = s.language || 'fr'
    rec.continuous = true
    // Le texte provisoire s'affiche dans la barre pendant qu'on parle ; le texte final s'ecrit dans la note.
    rec.interimResults = true
    let heard = false
    rec.onresult = e => {
      heard = true
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!
        if (r.isFinal) insertDictated(view, r[0].transcript)
        else interim += r[0].transcript
      }
      this.interim = interim.trim()
      this.emit()
    }
    rec.onerror = e => {
      if (e.error === 'no-speech' || e.error === 'aborted') return
      if (e.error === 'not-allowed') { this.stop(); notify('danger', 'Dictée', 'Micro refusé : autorisez-le pour Savoire.'); return }
      // Service de reconnaissance absent ou injoignable (bureau, Brave...) : on passe a la connexion IA.
      if (!heard && (e.error === 'network' || e.error === 'service-not-allowed' || e.error === 'language-not-supported')) {
        this.stop()
        if (this.fallBack(view, s, 'La dictée du navigateur ne répond pas ici.')) return
        notify('danger', 'Dictée', 'La dictée du navigateur ne répond pas ici. Ajoutez une connexion IA (OpenAI…) et choisissez-la dans Paramètres → IA → Dictée.')
        return
      }
      notify('danger', 'Dictée', `Erreur de reconnaissance : ${e.error}.`)
    }
    // Le navigateur coupe seul apres un silence : on relance tant que la personne n'a pas arrete.
    rec.onend = () => {
      if (this.stopFn === stop) { try { rec.start() } catch { this.stop() } }
    }
    const stop = () => { rec.onend = null; try { rec.stop() } catch { /* deja arrete */ } }
    this.stopFn = stop
    try { rec.start() } catch { this.stopFn = null; notify('danger', 'Dictée', 'Impossible de démarrer la dictée.'); return }
    this.emit()
  }

  /** Passe a la connexion IA (et le retient) quand le navigateur ne sait pas dicter. False : aucune connexion. */
  private fallBack(view: DictationView, s: DictationSettings, why: string): boolean {
    if (aiService.connections().length === 0) return false
    const next: DictationSettings = { ...s, source: 'connection' }
    saveDictationSettings(next)
    notify('info', 'Dictée', `${why} Elle passe par votre connexion IA (réglable dans Paramètres → IA → Dictée).`)
    void this.startRecording(view, next)
    return true
  }

  private async startRecording(view: DictationView, s: DictationSettings): Promise<void> {
    if (aiService.connections().length === 0) { notify('warn', 'Dictée', 'Aucune connexion IA : ajoutez-en une dans Paramètres → IA.'); return }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { notify('warn', 'Dictée', 'Enregistrement du son impossible ici.'); return }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      notify('danger', 'Dictée', 'Micro refusé : autorisez-le pour Savoire.')
      return
    }
    this.source = 'connection'
    const conn = dictationConnection(s)
    this.by = conn?.name ?? ''
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported?.(t))
    // Le texte s'ecrit dans l'ordre de la parole, meme si une transcription revient avant l'autre.
    let order: Promise<void> = Promise.resolve()
    const send = (blob: Blob) => {
      const ext = /mp4/.test(blob.type) ? 'm4a' : /ogg/.test(blob.type) ? 'ogg' : 'webm'
      this.pending++
      this.emit()
      const text = aiService.transcribe(blob, { connectionId: conn?.id, model: s.model || DEFAULT_TRANSCRIPTION_MODEL, language: s.language, fileName: `dictee.${ext}` })
      order = order.then(async () => {
        try {
          const t = await text
          if (t) insertDictated(view, t)
        } catch (err) {
          notify('danger', 'Dictée', err instanceof Error ? err.message : String(err))
        } finally {
          this.pending--
          this.emit()
        }
      })
    }

    // Un enregistreur par morceau : chaque morceau est un fichier complet.
    let recorder: MediaRecorder | null = null
    /** Le morceau en cours a-t-il de la parole ? Sans mesure du volume : on suppose que oui. */
    let piece = { voiced: false }
    let metered = false
    /** Une parole entendue depuis le debut ; sinon la mesure ne marche peut-etre pas : le dernier morceau part quand meme. */
    let everVoiced = false
    const startPiece = () => {
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
      const chunks: Blob[] = []
      const mine = { voiced: !metered }
      piece = mine
      r.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
      r.onstop = () => {
        const blob = new Blob(chunks, { type: r.mimeType || type || 'audio/webm' })
        // Un morceau sans parole n'est pas envoye (rien a transcrire, rien a payer).
        if (blob.size && mine.voiced) send(blob)
      }
      r.start()
      recorder = r
    }

    // Les pauses : le volume du micro, mesure ~10 fois par seconde.
    let audio: AudioContext | null = null
    let tick: ReturnType<typeof setInterval> | null = null
    try {
      audio = new AudioContext()
      // Cree apres l'accord du micro, il peut naitre suspendu (regles de lecture du navigateur).
      if (audio.state === 'suspended') void audio.resume().catch(() => {})
      const analyser = audio.createAnalyser()
      analyser.fftSize = 2048
      audio.createMediaStreamSource(stream).connect(analyser)
      const buf = new Float32Array(analyser.fftSize)
      const seg = new SilenceSegmenter(Date.now())
      tick = setInterval(() => {
        analyser.getFloatTimeDomainData(buf)
        let sum = 0
        for (const x of buf) sum += x * x
        const now = Date.now()
        const cut = seg.feed(Math.sqrt(sum / buf.length), now)
        if (seg.hasVoice) { piece.voiced = true; everVoiced = true }
        if (cut && recorder) {
          const done = recorder
          startPiece()
          seg.reset(now)
          done.stop()
        }
      }, 100)
      metered = true
    } catch {
      // Pas de mesure du volume : un seul morceau, envoye a l'arret.
      metered = false
    }

    const timer = setTimeout(() => { if (this.stopFn === stop) this.stop() }, MAX_RECORDING_MS)
    const stop = () => {
      clearTimeout(timer)
      if (tick) clearInterval(tick)
      const last = recorder
      recorder = null
      if (!everVoiced) piece.voiced = true
      if (last && last.state !== 'inactive') {
        // Le dernier morceau part, puis le micro se coupe.
        last.addEventListener('stop', () => stream.getTracks().forEach(t => t.stop()), { once: true })
        last.stop()
      } else stream.getTracks().forEach(t => t.stop())
      void audio?.close().catch(() => {})
    }
    this.stopFn = stop
    startPiece()
    this.emit()
  }
}

export const dictation = new Dictation()

// Etat de toute la session (editeur actif, abonnements, veilles) : un
// remplacement a chaud (Vite) en ferait un second exemplaire, jamais branche.
// Modifie pendant le developpement : on recharge la page.
if (import.meta.hot) import.meta.hot.accept(() => { window.location.reload() })
