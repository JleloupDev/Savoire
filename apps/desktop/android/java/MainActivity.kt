// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Activite principale de l'app Android. Remplace celle que genere
// `tauri android init` (scripts/android-extras.mjs la copie dans gen/android).
//
// En plus de celle de Tauri :
//
//  - elle dit a la page pourquoi l'app s'ouvre. Un appui sur le widget
//    « Note rapide » ouvre l'app avec l'action QUICK_NOTE ; la page la lit par
//    window.SavoireAndroid.takeLaunchAction() au demarrage
//    (apps/web/src/quickCapture/boot.ts). App deja ouverte : l'evenement
//    `savoire-android-launch` la previent ;
//  - la connexion se fait dans le navigateur du telephone
//    (SavoireAndroid.openInBrowser), qui revient par l'adresse propre a l'app
//    (org.savoire.desktop:/auth/callback). La page la prend par
//    takeAuthReturn() ; l'evenement `savoire-android-auth` la previent
//    (apps/web/src/loginFlow.ts, androidLoginDriver) ;
//  - la page ne passe ni sous la barre d'etat, ni sous la barre de
//    navigation, ni sous le clavier : l'app occupe tout l'ecran (Android 15),
//    la WebView ne connait pas ces marges.
package org.savoire.desktop

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  @Volatile
  private var launchAction: String = ""
  @Volatile
  private var authReturn: String = ""
  private var page: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    rememberLaunch(intent)
    super.onCreate(savedInstanceState)
    // Le clavier arrive dans les marges (ime) : la page se raccourcit
    // au lieu de glisser sous lui.
    @Suppress("DEPRECATION")
    window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    keepClearOfSystemBars(findViewById(android.R.id.content))
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    val event = rememberLaunch(intent) ?: return
    val view = page ?: return
    view.post { view.evaluateJavascript("window.dispatchEvent(new Event('$event'))", null) }
  }

  // Appele avant le chargement de la page : l'objet est la des le premier script.
  override fun onWebViewCreate(webView: WebView) {
    page = webView
    webView.addJavascriptInterface(LaunchBridge(), "SavoireAndroid")
  }

  /** Retient ce que l'intention demande ; rend l'evenement a envoyer a la page. */
  private fun rememberLaunch(intent: Intent?): String? {
    if (intent == null) return null
    if (intent.action == QuickNoteWidget.ACTION_QUICK_NOTE) {
      launchAction = "quick-note"
      return "savoire-android-launch"
    }
    val data = intent.data
    if (intent.action == Intent.ACTION_VIEW && data?.scheme == AUTH_SCHEME) {
      authReturn = data.toString()
      return "savoire-android-auth"
    }
    return null
  }

  /** Marges des barres du systeme et du clavier, en retrait du contenu. */
  private fun keepClearOfSystemBars(root: View) {
    ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
      v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
      WindowInsetsCompat.CONSUMED
    }
  }

  inner class LaunchBridge {
    /** L'action qui a ouvert l'app (« quick-note »), une seule fois ; vide sinon. */
    @JavascriptInterface
    fun takeLaunchAction(): String {
      val action = launchAction
      launchAction = ""
      return action
    }

    /** L'adresse de retour de la connexion, une seule fois ; vide sinon. */
    @JavascriptInterface
    fun takeAuthReturn(): String {
      val url = authReturn
      authReturn = ""
      return url
    }

    /** Ouvre une adresse web dans le navigateur du telephone. */
    @JavascriptInterface
    fun openInBrowser(url: String): Boolean {
      if (!url.startsWith("https://") && !url.startsWith("http://")) return false
      val view = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        .addCategory(Intent.CATEGORY_BROWSABLE)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      return try {
        startActivity(view)
        true
      } catch (e: ActivityNotFoundException) {
        false
      }
    }
  }

  companion object {
    /** Schema de l'adresse de retour de la connexion (apps/web/src/loginFlow.ts). */
    const val AUTH_SCHEME = "org.savoire.desktop"
  }
}
