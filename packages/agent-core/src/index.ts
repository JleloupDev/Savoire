// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// @savoire/agent-core : les agents IA (ADR-033), sans DOM.
//  - policy   : droits d'un agent (modes, portee, sous-agents) ;
//  - host     : le port que l'appli et le pair indexeur implementent ;
//  - presence : la couleur d'un agent dans les notes ;
//  - coreTools: les outils du socle, ecrits une fois ;
//  - noteRefs, readMemory, patch, anchor, typing : lire et ecrire une note par
//    morceaux (references de bloc, versions, retouches, ancres, effet de frappe) ;
//  - editorContext : ou travaille la personne dans l'editeur (selection, ancre), pour l'IA ;
//  - typingGuard : ne jamais ecrire dans le paragraphe ou la personne tape ;
//  - requests : une demande adressee a un agent par selection + commentaire ;
//  - toolbox  : les outils d'un agent pour une execution, filtres par ses droits ;
//  - engine   : la boucle (et la delegation a des sous-agents) ;
//  - watch    : la veille d'un agent sur la note ouverte, bloc par bloc.
export * from './policy'
export * from './host'
export * from './presence'
export * from './text'
export * from './anchor'
export * from './noteRefs'
export * from './readMemory'
export * from './patch'
export * from './typing'
export * from './coreTools'
export * from './editorContext'
export * from './typingGuard'
export * from './requests'
export * from './toolbox'
export * from './engine'
export * from './watch'
