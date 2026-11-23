// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Blocks ────────────────────────────────────────────────────────────────

export interface BlockWidget {
  mount(container: HTMLElement): void
  destroy(): void
}

/**
 * Evenement envoye sur l'element rendu par renderClient quand l'editeur le
 * retire pour de bon (bloc modifie, note fermee). Un rendu qui suit des
 * donnees en direct s'y desabonne.
 */
export const BLOCK_DESTROY_EVENT = 'savoire:block-destroy'

/**
 * Mode classique : le curseur arrive sur un bloc par les fleches. L'editeur
 * envoie cet evenement (annulable) a l'element du bloc. Le bloc qui prend la
 * main (il met le focus dans son titre, sa premiere case...) appelle
 * preventDefault() ; sinon le curseur passe le bloc. Il la rend par
 * BlockEditContext.leave.
 */
export const BLOCK_ENTER_EVENT = 'savoire:block-enter'

export interface BlockEnterDetail {
  /** 1 : on arrive par le haut (fleche bas) ; -1 : par le bas. */
  dir: 1 | -1
  /** Abscisse du curseur dans la page, pour viser la bonne colonne. */
  x: number | null
}

export interface BlockContext {
  editorView: unknown
  /** Remplace un passage du document (cocher une case, par exemple), sans
   *  passer par l'editeur. Absent ou sans effet en lecture seule. */
  edit?(from: number, to: number, insert: string): void
  /** Ligne du document qui porte ce rendu (pour la reecrire avec edit). Null si introuvable. */
  locate?(el: HTMLElement): { from: number; to: number; text: string } | null
  /**
   * Rend du Markdown comme le fait la note : gras, listes, tableaux, et les
   * blocs des autres plugins. Sert au contenu d'un bloc (le corps d'un
   * callout). Ce rendu est en lecture seule. Absent hors de l'editeur et de
   * l'export : le plugin montre alors le texte brut.
   */
  renderMarkdown?(markdown: string): HTMLElement
}

/** Describes an entry in the slash command palette for this block type. */
export interface BlockTrigger {
  id: string
  label: string
  description?: string
  icon?: string
  category?: string
  insert: string | ((ctx: { query: string }) => string)
}

/**
 * Une ligne d'un bloc rendu ligne par ligne (voir BlockSpec.renderLine).
 * Le texte est la ligne brute, indentation et marqueur compris.
 */
export interface BlockLine {
  text: string
  /** Profondeur d'imbrication : 0 pour un element de premier niveau. */
  depth: number
  /** Debut de la ligne dans le document : pour la modifier (case a cocher). */
  from: number
}

/**
 * Le marqueur (puce, numero, case a cocher) de la ligne en edition. Il prend
 * la place du `- ` brut : le texte reste ou il etait dans le rendu.
 */
export interface BlockLineMarker {
  /** Retrait de la ligne avant le marqueur (longueur CSS). */
  indent: string
  /** Le marqueur, en ligne ; sa largeur amene le texte a sa place. */
  el: HTMLElement
}

/**
 * Les trois facons d'editer une note Markdown.
 * - 'source' : le Markdown brut, sans aucun rendu.
 * - 'power' : le rendu en direct ; un bloc repasse en texte brut des que le
 *   curseur y entre (callout, tableau, colonnes...).
 * - 'classic' : les blocs restent des objets rendus. On agit dessus
 *   directement ; le clic droit donne « Modifier la source ».
 */
export type EditorMode = 'source' | 'power' | 'classic'

/**
 * Un bloc rendu en mode classique. Le plugin y lit la source du bloc et la
 * reecrit sans passer par le texte brut.
 */
export interface BlockEditContext extends BlockContext {
  /** Le texte brut du bloc, tel qu'il est maintenant dans la note. */
  source(): string
  /** Remplace tout le bloc par `next` (une seule modification, annulable). */
  replace(next: string): void
  /** Ouvre ce bloc en texte brut, comme « Modifier la source ». */
  editSource(): void
  /** Vrai en lecture seule : le rendu ne doit rien proposer de modifier. */
  readonly readOnly: boolean
  /**
   * Rend le curseur a la note : la ligne sous le bloc (1) ou au-dessus (-1),
   * creee s'il n'y en a pas.
   */
  leave?(dir: 1 | -1): void
}

/** Une entree du menu d'un bloc (clic droit, poignee). */
export interface BlockMenuItem {
  id: string
  label: string
  icon?: string
  /** Coche devant l'entree (le type actuel d'un callout, par exemple). */
  checked?: boolean
  /** Trait de separation avant cette entree. */
  separatorBefore?: boolean
  run(): void
}

export interface BlockSpec {
  type: string
  detect?: RegExp | ((text: string) => boolean)
  serialize(data: unknown): string
  deserialize(raw: string): unknown
  createEditorWidget(data: unknown, ctx: BlockContext): BlockWidget
  renderClient(data: unknown, ctx: BlockContext): HTMLElement
  /**
   * Rendu LIGNE PAR LIGNE, comme dans Obsidian. Quand il est fourni, chaque
   * ligne du bloc est rendue a part et seule la ligne du curseur passe en
   * edition (listes, citations). Sinon le bloc entier passe en edition des
   * qu'on y entre (code, callout, diagramme). Rend null pour laisser une ligne
   * telle quelle.
   */
  renderLine?(line: BlockLine, ctx: BlockContext): HTMLElement | null
  /**
   * Avec renderLine : le marqueur de la ligne en edition, aligne sur le
   * rendu. Sans lui, la ligne en edition montre son `- ` brut.
   */
  renderLineMarker?(line: BlockLine, ctx: BlockContext): BlockLineMarker | null
  /**
   * Rendu modifiable, pour le mode classique : on edite le bloc sans voir sa
   * syntaxe (changer le type d'un callout, ecrire dans son corps). Le rendu
   * ecrit avec ctx.replace. Sans lui, le mode classique montre renderClient,
   * et la source reste accessible par le clic droit.
   */
  renderEditable?(data: unknown, ctx: BlockEditContext): HTMLElement
  /**
   * Entrees propres au bloc dans son menu (clic droit, poignee), en mode
   * classique. L'editeur ajoute toujours « Modifier la source » et
   * « Supprimer ».
   */
  menu?(data: unknown, ctx: BlockEditContext): BlockMenuItem[]
  /**
   * Retirer le bloc en gardant son contenu (menu « Retirer le callout ») :
   * le cadre part, le contenu reste dans la note en Markdown ordinaire.
   * `label` est l'entree du menu, `content` le texte qui remplace le bloc.
   * Absent : pas d'entree.
   */
  unwrap?: { label: string; content(data: unknown): string }
  /** If defined, auto-registers slash command entries for this block. */
  trigger?: BlockTrigger | BlockTrigger[]
}

export interface BlockRegistry {
  register(spec: BlockSpec): void
  unregister(type: string): void
  detectBlock(text: string): { type: string; spec: BlockSpec } | null
  getAll(): BlockSpec[]
  /**
   * Returns only specs whose registering plugin is in `ids`, plus untagged built-ins.
   * null = no filtering (return all). Used by LivePreview to limit rendering per note scope.
   */
  getActive?(ids: Set<string> | null): BlockSpec[]
  /**
   * Like detectBlock but filtered by active scope ids.
   * null = no filtering (same as detectBlock). Used by LivePreview.
   */
  detectActive?(text: string, ids: Set<string> | null): { type: string; spec: BlockSpec } | null
}
