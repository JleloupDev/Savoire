// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les 66 livres, dans l'ordre (numerotation commune : 1 Genese ... 66
// Revelation), leurs abreviations et leur nombre de chapitres. Les noms sont
// ceux des notes du dossier Bible/ (« 01 - Genese/Genese 1.md »).
//
// Un alias de chapitre est l'alias du livre suivi du numero (« Gn 1 ») ; la
// comparaison se fait sans accents ni espaces (voir normalize()).

export interface BibleBook {
  /** 1 a 66. */
  number: number
  name: string
  aliases: string[]
  chapters: number
}

const B = (number: number, name: string, chapters: number, aliases: string[]): BibleBook => ({ number, name, chapters, aliases })

export const BOOKS: readonly BibleBook[] = [
  B(1, 'Genèse', 50, ['Gen', 'Gn']),
  B(2, 'Exode', 40, ['Ex']),
  B(3, 'Lévitique', 27, ['Lev', 'Lv']),
  B(4, 'Nombres', 36, ['Nb']),
  B(5, 'Deutéronome', 34, ['Deut', 'Dt']),
  B(6, 'Josué', 24, ['Jos', 'Js']),
  B(7, 'Juges', 21, ['Jug', 'Jg']),
  B(8, 'Ruth', 4, ['Ru', 'Rut', 'Rt']),
  B(9, '1 Samuel', 31, ['1 Sam', '1 Sa', '1 S', '1 Sm']),
  B(10, '2 Samuel', 24, ['2 Sam', '2 Sa', '2 S', '2 Sm']),
  B(11, '1 Rois', 22, ['1 Ro', '1 R']),
  B(12, '2 Rois', 25, ['2 Ro', '2 R']),
  B(13, '1 Chroniques', 29, ['1 Ch', '1 Chr', '1 Chron']),
  B(14, '2 Chroniques', 36, ['2 Ch', '2 Chr', '2 Chron']),
  B(15, 'Esdras', 10, ['Esd', 'Ezr', 'Esdra']),
  B(16, 'Néhémie', 13, ['Neh', 'Ne']),
  B(17, 'Esther', 10, ['Est', 'Esth', 'Es']),
  B(18, 'Job', 42, ['Jb']),
  B(19, 'Psaumes', 150, ['Ps', 'Psaume']),
  B(20, 'Proverbes', 31, ['Pr', 'Prov']),
  B(21, 'Ecclésiaste', 12, ['Ec', 'Ecc']),
  B(22, 'Chant de Salomon', 8, ['Ct']),
  B(23, 'Isaïe', 66, ['Is']),
  B(24, 'Jérémie', 52, ['Jr', 'Jer']),
  B(25, 'Lamentations', 5, ['Lm', 'Lam']),
  B(26, 'Ezéchiel', 48, ['Ez', 'Ezk']),
  B(27, 'Daniel', 12, ['Dn', 'Dan']),
  B(28, 'Osée', 14, ['Os']),
  B(29, 'Joel', 3, ['Jl', 'Joël']),
  B(30, 'Amos', 9, ['Am']),
  B(31, 'Abdias', 1, ['Ab', 'Abd']),
  B(32, 'Jonas', 4, ['Jon']),
  B(33, 'Michée', 7, ['Mi']),
  B(34, 'Nahum', 3, ['Na']),
  B(35, 'Habacuc', 3, ['Ha', 'Hab']),
  B(36, 'Sophonie', 3, ['So']),
  B(37, 'Aggée', 2, ['Ag']),
  B(38, 'Zacharie', 14, ['Za']),
  B(39, 'Malachie', 4, ['Ml']),
  B(40, 'Matthieu', 28, ['Mt']),
  B(41, 'Marc', 16, ['Mc']),
  B(42, 'Luc', 24, ['Lc']),
  B(43, 'Jean', 21, ['Jn']),
  B(44, 'Actes', 28, ['Ac']),
  B(45, 'Romains', 16, ['Rm', 'Rom']),
  B(46, '1 Corinthiens', 16, ['1 Co', '1 Cor']),
  B(47, '2 Corinthiens', 13, ['2 Co', '2 Cor']),
  B(48, 'Galates', 6, ['Ga', 'Gal']),
  B(49, 'Ephésiens', 6, ['Ep', 'Eph', 'Éphésiens']),
  B(50, 'Philippiens', 4, ['Ph', 'Php']),
  B(51, 'Colossiens', 4, ['Col']),
  B(52, '1 Thessaloniciens', 5, ['1 Th']),
  B(53, '2 Thessaloniciens', 3, ['2 Th']),
  B(54, '1 Timothée', 6, ['1 Tm', '1 Tim']),
  B(55, '2 Timothée', 4, ['2 Tm', '2 Tim']),
  B(56, 'Tite', 3, ['Tt']),
  B(57, 'Philémon', 1, ['Phm']),
  B(58, 'Hébreux', 13, ['He', 'Heb']),
  B(59, 'Jacques', 5, ['Jc']),
  B(60, '1 Pierre', 5, ['1 P', '1 Pi']),
  B(61, '2 Pierre', 3, ['2 P', '2 Pi']),
  B(62, '1 Jean', 5, ['1 Jn']),
  B(63, '2 Jean', 1, ['2 Jn']),
  B(64, '3 Jean', 1, ['3 Jn']),
  B(65, 'Jude', 1, ['Jd']),
  B(66, 'Révélation', 22, ['Rev', 'Ap']),
]

/** Nombre de chapitres de toute la Bible. */
export const CHAPTER_COUNT = BOOKS.reduce((n, b) => n + b.chapters, 0)
