// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pieces jointes du profil serveur. Le serveur exige le jeton pour LIRE une
// image : une balise <img> ne sait pas l'envoyer. On lit donc l'image en
// fetch authentifie et on l'affiche par une URL blob:, gardee en cache le
// temps de la session (le profil pair a pair fait de meme).
import type { IVaultFiles } from '@savoire/platform'
import type { RestVaultStorage } from './RestVaultStorage'

export class ServerVaultFiles implements IVaultFiles {
  private readonly urls = new Map<string, Promise<string>>()
  private readonly created: string[] = []

  constructor(
    private readonly storage: RestVaultStorage,
    private readonly vaultId: string,
    private readonly token: () => string,
  ) {}

  async upload(fileId: string, file: Blob): Promise<void> {
    await this.storage.putAttachment(this.vaultId, fileId, file, this.token())
    // Un fichier remplace ne doit pas garder l'ancienne image en cache.
    this.urls.delete(fileId)
  }

  url(fileId: string): Promise<string> {
    let url = this.urls.get(fileId)
    if (!url) {
      url = this.storage.fetchAttachment(this.vaultId, fileId, this.token()).then(blob => {
        const u = URL.createObjectURL(blob)
        this.created.push(u)
        return u
      })
      // Un echec n'est pas garde : le fichier peut arriver plus tard.
      url.catch(() => { if (this.urls.get(fileId) === url) this.urls.delete(fileId) })
      this.urls.set(fileId, url)
    }
    return url
  }

  read(fileId: string): Promise<string> {
    return this.storage.readFile(this.vaultId, fileId, this.token())
  }

  dispose(): void {
    for (const u of this.created.splice(0)) URL.revokeObjectURL(u)
    this.urls.clear()
  }
}
