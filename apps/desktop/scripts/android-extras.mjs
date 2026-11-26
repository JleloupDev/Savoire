// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ajoute au projet Android genere par `tauri android init` (src-tauri/gen/android,
// ignore par git et refait a chaque construction) ce que Savoire y met en plus :
//
//  - android/java/*.kt : l'activite principale (remplace celle de Tauri) et le
//    widget « Note rapide » ;
//  - android/res/** : la mise en page, les images et les textes du widget ;
//  - le widget declare dans AndroidManifest.xml, et l'adresse de retour de la
//    connexion (org.savoire.desktop:/auth/callback) donnee a l'activite.
//
// A lancer entre `tauri android init` et `tauri android build` (voir
// .github/workflows/desktop.yml). Le relancer ne change rien de plus.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(here, '..')
const extras = join(desktop, 'android')
const main = join(desktop, 'src-tauri', 'gen', 'android', 'app', 'src', 'main')
// Le paquet de l'app : l'identifiant de tauri.conf.json.
const identifier = JSON.parse(readFileSync(join(desktop, 'src-tauri', 'tauri.conf.json'), 'utf8')).identifier
const javaDir = join(main, 'java', ...identifier.split('.'))
const manifestPath = join(main, 'AndroidManifest.xml')

if (!existsSync(manifestPath)) {
  console.error(`Projet Android introuvable (${manifestPath}) : lancer d'abord \`tauri android init\`.`)
  process.exit(1)
}
if (identifier !== 'org.savoire.desktop') {
  // Les fichiers Kotlin declarent ce paquet : ils ne compileraient pas ailleurs.
  console.error(`Identifiant inattendu (${identifier}) : mettre a jour le paquet des fichiers de android/java.`)
  process.exit(1)
}

mkdirSync(javaDir, { recursive: true })
for (const name of readdirSync(join(extras, 'java'))) {
  cpSync(join(extras, 'java', name), join(javaDir, name))
  console.log(`java/${name}`)
}
cpSync(join(extras, 'res'), join(main, 'res'), { recursive: true })
console.log('res/')

const RECEIVER = `        <receiver
            android:name=".QuickNoteWidget"
            android:exported="false"
            android:label="@string/quick_note_widget_label">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data
                android:name="android.appwidget.provider"
                android:resource="@xml/quick_note_widget_info" />
        </receiver>
`
// L'adresse de retour de la connexion (apps/web/src/loginFlow.ts) : le
// navigateur du telephone la donne a l'activite principale.
const AUTH_FILTER = `            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="${identifier}" />
            </intent-filter>
`
let manifest = readFileSync(manifestPath, 'utf8')
if (!manifest.includes(`android:scheme="${identifier}"`)) {
  const activity = manifest.search(/android:name="\.MainActivity"/)
  const close = activity < 0 ? -1 : manifest.indexOf('</activity>', activity)
  if (close < 0) {
    console.error('AndroidManifest.xml sans activite .MainActivity : adresse de retour non declaree.')
    process.exit(1)
  }
  const lineStart = manifest.lastIndexOf('\n', close) + 1
  manifest = manifest.slice(0, lineStart) + AUTH_FILTER + manifest.slice(lineStart)
  writeFileSync(manifestPath, manifest)
  console.log('AndroidManifest.xml : adresse de retour de la connexion declaree')
}
if (!manifest.includes('.QuickNoteWidget')) {
  if (!manifest.includes('</application>')) {
    console.error('AndroidManifest.xml sans </application> : widget non declare.')
    process.exit(1)
  }
  manifest = manifest.replace(/\n([ \t]*)<\/application>/, (_m, indent) => `\n${RECEIVER}${indent}</application>`)
  writeFileSync(manifestPath, manifest)
  console.log('AndroidManifest.xml : widget declare')
}
