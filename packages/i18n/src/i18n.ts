// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { layoutFr } from './locales/layout.fr'
import { layoutEn } from './locales/layout.en'
import { editorFr } from './locales/editor.fr'
import { editorEn } from './locales/editor.en'
import { appFr } from './locales/app.fr'
import { appEn } from './locales/app.en'

export type Locale = 'fr' | 'en'

const STORAGE_KEY = 'savoire:locale'

const translations = {
  fr: { layout: layoutFr, editor: editorFr, app: appFr },
  en: { layout: layoutEn, editor: editorEn, app: appEn },
} as const

type Namespaces = typeof translations['fr']
export type Namespace = keyof Namespaces
export type TranslationKey<N extends Namespace> = keyof Namespaces[N] & string

let currentLocale: Locale = (() => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'fr' || stored === 'en') return stored
  } catch {
    // localStorage unavailable (SSR / test)
  }
  return 'fr'
})()

const subscribers: Set<(locale: Locale) => void> = new Set()

export function getLocale(): Locale {
  return currentLocale
}

export function setLocale(locale: Locale): void {
  if (locale === currentLocale) return
  currentLocale = locale
  try { localStorage.setItem(STORAGE_KEY, locale) } catch { /* ignore */ }
  for (const cb of subscribers) cb(locale)
}

export function subscribeLocale(cb: (locale: Locale) => void): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}

export function t<N extends Namespace>(namespace: N, key: TranslationKey<N>): string {
  const dict = translations[currentLocale][namespace] as Record<string, string>
  return dict[key] ?? (translations['fr'][namespace] as Record<string, string>)[key] ?? key
}

export function ti<N extends Namespace>(
  namespace: N,
  key: TranslationKey<N>,
  vars: Record<string, string>,
): string {
  return Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, v), t(namespace, key))
}
