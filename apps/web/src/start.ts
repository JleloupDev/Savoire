// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Point d'entree de la page. D'abord l'ecran de la note rapide, s'il est
// demande : il tient dans ce petit fichier et s'affiche tout de suite. Puis
// l'appli, chargee a part (import dynamique), qui se monte dessous.
//
// Deux balises <script> dans index.html ne suffiraient pas : Vite les fond en
// un seul fichier a la construction, et l'ecran attendrait toute l'appli.
import './quickCapture/boot'

void import('./main')
