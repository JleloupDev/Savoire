// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { VaultClient, type DocumentStore, type IDocumentMeta, type IVaultDirectory, type IVaultStorage } from '@savoire/platform'
import type {
  ActivatedVault, ActivateVaultParams, ActivateSharedDocParams,
  IDocumentsAPI, IVaultSyncSession, IVaultSyncSessionFactory,
} from './contracts'

export class DocumentsService implements IDocumentsAPI {
  private active: ActivatedVault | null = null

  constructor(private readonly sessionFactory: IVaultSyncSessionFactory) {}

  async activateVault(params: ActivateVaultParams): Promise<ActivatedVault> {
    await this.disposeActiveVault()

    // La session cree le repertoire ET les CRDT des documents. L'application
    // n'instancie aucun adaptateur : changer de protocole = changer de
    // fabrique. Voir IVaultSyncSession pour le pourquoi de cette inversion.
    const session = await this.sessionFactory.open({
      vaultId: params.vaultId,
      token: params.token,
      userId: params.userId,
      identitySeed: params.identitySeed,
      identity: params.identity,
      onChanged: params.onChanged,
      onConnectionChange: params.onConnectionChange,
    })

    const client = new VaultClient(
      params.vaultId,
      params.token,
      params.storage,
      params.documentStore,
      session.directory,
      params.resolveDoc,
    )

    const active: ActivatedVault = {
      vaultId: params.vaultId,
      client,
      session,
      dispose: async () => { await session.dispose() },
    }
    this.active = active
    return active
  }

  /**
   * Active un document partage seul, sans session de vault : l'appelant a une
   * ACL au niveau document mais n'est pas membre du vault. Le VaultClient est
   * pre-rempli avec l'unique document connu et toute ecriture echoue.
   * see ADR-027
   */
  async activateSharedDocument(params: ActivateSharedDocParams): Promise<ActivatedVault> {
    await this.disposeActiveVault()

    const d = params.doc
    const readOnly = async (): Promise<never> => { throw new Error('read-only shared document') }
    const stubStorage: IVaultStorage = {
      listDocuments:    async () => [d],
      readFile:         async () => '',
      writeFile:        readOnly,
      resolveFileUrl:   () => '',
      uploadAttachment: readOnly,
    }

    const client = new VaultClient(
      params.vaultId,
      params.token,
      stubStorage,
      params.documentStore,
      params.directory,
      params.resolveDoc,
    )
    client.addDocument(d)

    const active: ActivatedVault = {
      vaultId: params.vaultId,
      client,
      dispose: async () => {},
    }
    this.active = active
    return active
  }

  getActiveClient(): VaultClient | undefined {
    return this.active?.client
  }

  getActiveSession(): IVaultSyncSession | undefined {
    return this.active?.session
  }

  async disposeActiveVault(): Promise<void> {
    if (!this.active) return
    const active = this.active
    this.active = null
    // Attendu : une activation suivante ne doit pas doubler la fermeture de
    // cette connexion.
    await active.dispose()
  }
}

export type { IVaultDirectory, DocumentStore, IDocumentMeta }
