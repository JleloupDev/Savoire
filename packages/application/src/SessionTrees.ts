// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Arbres de documents et arbres ANNEXES, ouverts par la session du vault.
//
// Un arbre annexe est un document CRDT rattache a un autre (les lots de
// lignes d'une base) : il a son propre id, derive de celui du document et
// d'un nom, donc le meme chez tous les membres sans rien stocker. Il n'est
// pas dans l'arborescence du vault : on ne le voit pas, on ne le deplace
// pas, il suit son document par son id. Il passe par le meme port que tout
// le reste (openDocument / openTree) : serveur, pair a pair, bureau.
//
// La session doit compter ses ouvertures (withDocumentRefCount) : un lot lu
// par l'index et ecrit par la vue est le meme document.
import type { ISharedTree } from '@savoire/plugin-api'
import type { IVaultSyncSession } from './contracts'

/** Id du document annexe `name` d'un document. */
export function annexDocId(docId: string, name: string): string {
  return `${docId}~${name}`
}

export interface ITreeSource {
  /** Arbre d'un document du vault, ouvert jusqu'a close(). */
  open(docId: string): Promise<ISharedTree>
  close(docId: string): void
  /**
   * Arbre annexe `name` du document. `create` : l'inscrire d'abord aupres du
   * gardien du vault (mode serveur), pour pouvoir y ecrire ; un lecteur ne
   * l'inscrit pas, il ne fait que lire un annexe qui existe deja.
   */
  openAnnex(docId: string, name: string, options?: { create?: boolean }): Promise<ISharedTree>
  closeAnnex(docId: string, name: string): void
}

export function sessionTrees(session: IVaultSyncSession): ITreeSource {
  const created = new Set<string>()
  return {
    async open(docId) {
      session.openDocument(docId)
      return session.openTree(docId)
    },
    close(docId) {
      session.closeDocument(docId)
    },
    async openAnnex(docId, name, options) {
      const id = annexDocId(docId, name)
      if (options?.create && !created.has(id)) {
        // Refus (lecteur, hors ligne) : on lit quand meme ce qui existe.
        await session.registerDocuments([id]).then(() => { created.add(id) }, err => {
          console.warn('[SessionTrees] inscription du document annexe refusee', id, err)
        })
      }
      session.openDocument(id)
      return session.openTree(id)
    },
    closeAnnex(docId, name) {
      session.closeDocument(annexDocId(docId, name))
    },
  }
}
