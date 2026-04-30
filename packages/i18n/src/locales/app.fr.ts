// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
export const appFr = {
  // Login
  'login.title': 'Connexion',
  'login.subtitle': 'Entrez vos identifiants pour accéder à votre vault.',
  'login.email': 'Email',
  'login.password': 'Mot de passe',
  'login.submit': 'Se connecter →',
  'login.submitting': 'Connexion…',
  'login.forgot': 'Mot de passe oublié ?',
  'login.error.credentials': 'Email ou mot de passe incorrect.',
  'login.feature.markdown': 'Markdown natif — édition WYSIWYG ou source',
  'login.feature.wikilinks': 'Wikilinks et backlinks automatiques',
  'login.feature.collab': 'Collaboration temps réel (Yjs CRDT)',
  'login.feature.plugins': 'Extensible par plugins',

  // Admin
  'admin.title': 'Administration — Utilisateurs',
  'admin.user.email': 'Email',
  'admin.user.displayName': 'Nom affiché',
  'admin.user.password': 'Mot de passe',
  'admin.user.passwordHint': 'Min. 8 caractères',
  'admin.user.create': 'Créer un utilisateur',
  'admin.user.createSubmit': "Créer l'utilisateur",
  'admin.user.creating': 'Création…',
  'admin.user.created': 'Utilisateur {email} créé.',
  'admin.user.isAdmin': 'Administrateur',
  'admin.user.badge.admin': 'ADMIN',
  'admin.user.badge.disabled': 'DÉSACTIVÉ',
  'admin.list.title': 'Utilisateurs ({count})',
  'admin.list.loading': 'Chargement…',
  'admin.back': '← Éditeur',
  'admin.refresh': 'Rafraîchir',
  'topbar.logout': 'Déconnexion',

  // Sharing
  'sharing.title': 'Partager',
  'sharing.resource.note': 'Note',
  'sharing.resource.vault': 'Vault',
  'sharing.loading': 'Chargement…',
  'sharing.addUser': 'Ajouter un utilisateur',
  'sharing.permission.read': 'Lecture',
  'sharing.permission.write': 'Écriture',
  'sharing.permission.admin': 'Admin',
  'sharing.empty': 'Aucun accès partagé.',
  'sharing.createLink': 'Créer un lien de partage',
  'sharing.createLinkSubmit': 'Créer le lien',
  'sharing.error.userNotFound': 'Utilisateur introuvable',
  'sharing.error.search': 'Erreur de recherche',
  'sharing.revoke': 'Révoquer',
  'sharing.copy': 'Copier',
  'sharing.tab.users': 'Utilisateurs ({count})',
  'sharing.tab.links': 'Liens ({count})',
  'sharing.tab.usersEmpty': 'Utilisateurs',
  'sharing.tab.linksEmpty': 'Liens',
  'sharing.resolving': 'Recherche…',
  'sharing.currentAccess': 'Accès actuels',
  'sharing.activeLinks': 'Liens actifs',
  'sharing.noLinks': 'Aucun lien actif.',

  // Settings
  'settings.title': 'Paramètres',
  'settings.tab.plugins': 'Plugins',
  'settings.tab.triggers': 'Triggers',
  'settings.tab.themes': 'Thèmes',
  'settings.plugins.empty': 'Aucun plugin chargé.',
  'settings.plugins.active': 'Actif',
  'settings.triggers.empty': 'Aucun trigger enregistré.',
  'settings.triggers.description': 'Les triggers sont les séquences de caractères réservées par les plugins. Un conflit indique que deux plugins essaient d\'utiliser le même caractère.',
  'settings.triggers.col.char': 'Caractère',
  'settings.triggers.col.plugin': 'Plugin',
  'settings.triggers.col.description': 'Description',
  'settings.themes.description': 'Sélectionnez un thème. La préférence est sauvegardée localement.',
  'settings.theme.light': 'Light',
  'settings.theme.dark': 'Dark',
  'settings.theme.sepia': 'Sépia',
  'settings.theme.solarized': 'Solarized',

  // Quick open
  'quickopen.placeholder': 'Ouvrir une note…',
  'quickopen.empty': 'Aucun résultat',
  'quickopen.hint.navigate': 'naviguer',
  'quickopen.hint.open': 'ouvrir',
  'quickopen.hint.close': 'fermer',

  // Sync
  'sync.disconnected': 'Connexion perdue',
  'sync.reconnected': 'Reconnecté',

  // Sharing notifications
  'notify.sharing.grantSuccess': 'Accès accordé',
  'notify.sharing.revokeSuccess': 'Accès révoqué',
  'notify.sharing.linkCreated': 'Lien de partage créé',
  'notify.sharing.linkRevoked': 'Lien révoqué',
  'notify.sharing.copied': 'Lien copié',

  // Admin notifications
  'notify.admin.userCreated': 'Utilisateur créé',
  'notify.admin.passwordReset': 'Mot de passe réinitialisé',

  // Topbar
  'topbar.share': 'Partager',
  'topbar.noVault': '—',
  'topbar.saved': 'Enregistré ✓',
  'topbar.editor.toggle': "Basculer l'éditeur",
  'topbar.editor.source': 'CM6',
  'topbar.editor.rich': 'Rich',
} as const
