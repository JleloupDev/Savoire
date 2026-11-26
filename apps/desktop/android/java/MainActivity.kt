// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Activite principale de l'app Android. Remplace celle que genere
// `tauri android init` (scripts/android-extras.mjs la copie dans gen/android).
//
// En plus de celle de Tauri : elle dit a la page pourquoi l'app s'ouvre. Un
// appui sur le widget « Note rapide » ouvre l'app avec l'action QUICK_NOTE ;
// la page la lit par window.SavoireAndroid.takeLaunchAction() au demarrage
// (apps/web/src/quickCapture/boot.ts). App deja ouverte : l'evenement
// `savoire-android-launch` la previent.
package org.savoire.desktop

import android.content.Intent
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  @Volatile
  private var launchAction: String = ""
  private var page: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    rememberLaunch(intent)
    super.onCreate(savedInstanceState)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    if (rememberLaunch(intent)) {
      val view = page ?: return
      view.post { view.evaluateJavascript("window.dispatchEvent(new Event('savoire-android-launch'))", null) }
    }
  }

  // Appele avant le chargement de la page : l'objet est la des le premier script.
  override fun onWebViewCreate(webView: WebView) {
    page = webView
    webView.addJavascriptInterface(LaunchBridge(), "SavoireAndroid")
  }

  private fun rememberLaunch(intent: Intent?): Boolean {
    if (intent?.action != QuickNoteWidget.ACTION_QUICK_NOTE) return false
    launchAction = "quick-note"
    return true
  }

  inner class LaunchBridge {
    /** L'action qui a ouvert l'app (« quick-note »), une seule fois ; vide sinon. */
    @JavascriptInterface
    fun takeLaunchAction(): String {
      val action = launchAction
      launchAction = ""
      return action
    }
  }
}
