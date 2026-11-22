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
//                   poste : whisper.cpp, Speaches...). On enregistre, puis
//                   le texte arrive a l'arret.
import { notify } from '@savoire/notifications'
import { aiAccount, aiService } from './aiService'

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
  const fallback: DictationSettings = {
    source: browserDictationAvailable() || aiService.connections().length === 0 ? 'browser' : 'connection',
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

class Dictation {
  private stopFn: (() => void) | null = null
  private readonly listeners = new Set<() => void>()
  /** Transcription en cours (apres l'arret, source 'connection'). */
  busy = false

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
    for (const cb of this.listeners) cb()
  }

  /** Demarre, ou arrete si elle tourne deja. */
  toggle(view: unknown): void {
    if (this.stopFn) { this.stop(); return }
    if (this.busy) return
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
    f?.()
    this.emit()
  }

  private startBrowser(view: DictationView, s: DictationSettings): void {
    const R = recognitionClass()
    if (!R) { notify('warn', 'Dictée', 'Ce navigateur ne sait pas dicter. Choisissez une connexion IA dans Paramètres → IA → Dictée.'); return }
    const rec = new R()
    rec.lang = s.language || 'fr'
    rec.continuous = true
    rec.interimResults = false
    rec.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!
        if (r.isFinal) insertDictated(view, r[0].transcript)
      }
    }
    rec.onerror = e => {
      if (e.error === 'no-speech' || e.error === 'aborted') return
      notify('danger', 'Dictée', e.error === 'not-allowed' ? 'Micro refusé : autorisez-le pour Savoire.' : `Erreur de reconnaissance : ${e.error}.`)
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
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported?.(t))
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
    const chunks: Blob[] = []
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
    recorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop())
      const blob = new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' })
      if (!blob.size) return
      const ext = /mp4/.test(blob.type) ? 'm4a' : /ogg/.test(blob.type) ? 'ogg' : 'webm'
      this.busy = true
      this.emit()
      aiService.transcribe(blob, { connectionId: s.connectionId, model: s.model || DEFAULT_TRANSCRIPTION_MODEL, language: s.language, fileName: `dictee.${ext}` })
        .then(text => { if (text) insertDictated(view, text); else notify('info', 'Dictée', 'Rien entendu.') })
        .catch(err => notify('danger', 'Dictée', err instanceof Error ? err.message : String(err)))
        .finally(() => { this.busy = false; this.emit() })
    }
    const timer = setTimeout(() => { if (this.stopFn === stop) this.stop() }, MAX_RECORDING_MS)
    const stop = () => { clearTimeout(timer); if (recorder.state !== 'inactive') recorder.stop() }
    this.stopFn = stop
    recorder.start()
    notify('info', 'Dictée', 'Parlez… Cliquez de nouveau sur le micro pour écrire le texte.')
    this.emit()
  }
}

export const dictation = new Dictation()
