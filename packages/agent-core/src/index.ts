// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// @savoire/agent-core : les agents IA (ADR-033), sans DOM.
//  - policy   : droits d'un agent (modes, portee, sous-agents) ;
//  - host     : le port que l'appli et le pair indexeur implementent ;
//  - coreTools: les outils du socle, ecrits une fois ;
//  - toolbox  : les outils d'un agent pour une execution, filtres par ses droits ;
//  - engine   : la boucle (et la delegation a des sous-agents) ;
//  - watch    : la veille d'un agent sur la note ouverte, bloc par bloc.
export * from './policy'
export * from './host'
export * from './text'
export * from './coreTools'
export * from './toolbox'
export * from './engine'
export * from './watch'
