// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Moteur LaTeX (plugin-latex, @siglum/engine) : l'acceleration BLAKE3 est
// optionnelle et son entree navigateur ne se construit pas avec Vite. Le
// moteur retombe sur son empreinte simple (detection de changements, pas de
// securite : l'integrite du moteur est verifiee en SHA-256 a part).
throw new Error('BLAKE3 desactive dans cette construction')
export function hash() {}
