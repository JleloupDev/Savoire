// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Connecteur EdgeSync — le SEUL paquet de Savoire qui dépend de
// `edgesync-protocol`. Rien dans le cœur (domain, platform, application,
// editor-core, infrastructure-sync) ne doit importer d'ici : l'application se
// branche dessus uniquement par les ports de @savoire/application, choisis au
// composition root. EdgeSync ne connaît pas Savoire ; toute l'adaptation vit
// de ce côté-ci de la frontière.
export * from './EdgesyncRelayTransport'
export * from './EdgesyncWebRtcTransport'
export * from './EdgesyncAwarenessChannel'
export * from './EdgesyncIndexChannel'
export * from './EdgesyncVaultSession'
export * from './RemoteEdgesyncBlobStorage'
export * from './VaultKeyEscrow'
export * from './EdgesyncVaultSyncSession'
