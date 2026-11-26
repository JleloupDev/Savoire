// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Widget « Note rapide » de l'ecran d'accueil : une barre qui ouvre l'app sur
// l'ecran de saisie. Ce qui est tape va a la fin de la note du jour (plugin
// Agenda, voir packages/plugins/plugin-agenda/src/quickCapture.ts).
package org.savoire.desktop

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

class QuickNoteWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
    val open = Intent(context, MainActivity::class.java).apply {
      action = ACTION_QUICK_NOTE
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    val pending = PendingIntent.getActivity(
      context, 0, open,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    for (id in appWidgetIds) {
      val views = RemoteViews(context.packageName, R.layout.quick_note_widget)
      views.setOnClickPendingIntent(R.id.quick_note_widget_root, pending)
      appWidgetManager.updateAppWidget(id, views)
    }
  }

  companion object {
    const val ACTION_QUICK_NOTE = "org.savoire.desktop.QUICK_NOTE"
  }
}
