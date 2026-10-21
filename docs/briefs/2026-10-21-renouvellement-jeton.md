# Brief : renouveler automatiquement le jeton de connexion

Ce brief est écrit pour une session Claude Code dans le cloud, qui repart du dépôt sans l'historique de la conversation.

## Le problème

À la connexion, le serveur donne deux jetons :

- le **jeton d'accès** (JWT), valable **15 minutes** (`Jwt:AccessTokenExpirationMinutes`, `backend/Savoire.API/appsettings.Development.json`) ;
- le **jeton de renouvellement**, valable **7 jours**. Chaque renouvellement en rend un **nouveau** et invalide l'ancien (rotation).

L'application ne se sert du jeton de renouvellement qu'au démarrage (restaurer la session) et au changement de compte (`switchAccount`, `apps/web/src/AuthContext.tsx`). **Pendant l'utilisation, elle ne renouvelle jamais le jeton d'accès.** Au bout de 15 minutes :

- les connexions SignalR déjà ouvertes continuent (le jeton n'est vérifié qu'à leur ouverture) ;
- tout le reste est refusé en **401** : requêtes REST (liste des vaults, envoi d'image, partage, téléchargement), reconnexion d'un hub (coupure réseau, veille), ouverture d'un autre vault.

Recharger la page répare tout, d'où le fait qu'on ne l'a pas vu plus tôt. Ça touche le navigateur **et** l'application de bureau (Tauri).

## Ce qu'il faut faire

1. **Renouvellement proactif.** Tant qu'un compte est connecté, renouveler le jeton d'accès environ une minute avant son expiration (lire `exp` dans le JWT, sans dépendance). Repartir correctement après une mise en veille (le minuteur a pu dormir : vérifier l'expiration au réveil / au retour du focus).
2. **Un seul renouvellement à la fois** (single-flight) : à cause de la rotation, deux renouvellements simultanés avec le même jeton font échouer le second. Les appels concurrents attendent le même renouvellement.
3. **Sur un 401** d'une requête REST : renouveler une fois, puis rejouer la requête une fois. Pas de boucle. Pas de rejeu sur les routes d'authentification elles-mêmes (`/api/v1/auth/*`).
4. **SignalR** : les hubs prennent déjà le jeton par une fonction (`accessTokenFactory: () => getToken()`, dans `VaultHubClient`, `DocumentRoomClient`, `SignalRTransport`, `CrdtDocumentFetcher` ; `getToken` vient de `tokenRef` dans `apps/web/src/AppShell.tsx`). Vérifier qu'après un renouvellement, une reconnexion utilise bien le nouveau jeton.
5. **Échec du renouvellement** (jeton de 7 jours expiré, compte révoqué) : un seul message clair, « Votre session a expiré, reconnectez-vous », et retour à l'écran de connexion. Pas d'erreurs en série. **Une erreur réseau** (serveur injoignable) ne doit **pas** supprimer le compte gardé : réessayer plus tard (voir `isNetworkError` dans `switchAccount`).
6. **Partout** :
   - navigateur : plusieurs comptes possibles, seul le compte actif est renouvelé ;
   - application de bureau : un seul compte serveur, géré par `apps/web/src/desktopConnection.ts` (jeton du compte serveur, distinct du compte local de l'app) ; le jeton renouvelé doit aussi être mémorisé (`server-sessions.json`, via `serverConnection.ts` / `accountStorage.ts`).

Placer la logique à un seul endroit (par exemple un petit module « session » dans `apps/web/src`, ou dans `packages/infrastructure-sync/src/http.ts` pour le rejeu) plutôt que de toucher chaque appel.

## Fichiers à lire d'abord

- `apps/web/src/AuthContext.tsx` (`login`, `switchAccount`, restauration au démarrage)
- `apps/web/src/api.ts` (`authApi.refresh`, `authApi.logout`)
- `packages/infrastructure-sync/src/http.ts` et les clients REST (`Http*Backend`, `RestVaultStorage`, `ServerVaultFiles`)
- `apps/web/src/desktopConnection.ts`, `serverConnection.ts`, `accountStorage.ts`
- `apps/web/src/AppShell.tsx` (`tokenRef`, `getToken`)
- Backend : `backend/Savoire.Infrastructure/Auth/TokenService.cs`, contrôleur d'auth (`/api/v1/auth/refresh`)

## Tests

- Unitaires (vitest), nouveaux fichiers dans les suites existantes : renouvellement avant expiration, single-flight sous appels concurrents, 401 puis rejeu unique, pas de rejeu sur `/auth/*`, échec du renouvellement → déconnexion propre, erreur réseau → compte gardé, bureau (jeton mémorisé après renouvellement).
- Backend : si un test manque, un test d'intégration « renouveler deux fois avec le même jeton : le second est refusé » documente la rotation.
- Lancer :
  ```sh
  cd frontend && pnpm install && pnpm run test:unit
  pnpm -r --no-bail typecheck   # des erreurs existaient avant ; n'en ajouter aucune
  dotnet test tests/Server.Unit.Tests && dotnet test tests/Server.Integration.Tests
  ```
- Pour essayer à la main sans attendre 15 minutes : mettre `Jwt:AccessTokenExpirationMinutes` à 1 en développement (sans le commiter).

## Règles du dépôt

- Lire `AGENT.md`. Pas de nouvelle dépendance sans accord. Ne pas réécrire un test existant qui échoue : le signaler.
- Commentaires en français, sans accents dans le code, phrases courtes ; en-tête SPDX (`AGPL-3.0-or-later`, `2026 Jean Leloup`) sur chaque nouveau fichier.
- Commits directement sur `master`, puis push. Pas de tiret long (—) dans les messages de commit. Terminer chaque message de commit par :
  ```
  Co-Authored-By: jleloupdev <jleloupdev@outlook.com>
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```
- Le serveur de développement n'est pas accessible depuis le cloud : pas de test dans la vraie application. Le dire dans le compte rendu ; la vérification en vrai sera faite ensuite sur la machine de développement.

## Compte rendu attendu

Ce qui a changé et où, les tests ajoutés et leurs résultats, ce qui n'a pas pu être vérifié, et les limites.
