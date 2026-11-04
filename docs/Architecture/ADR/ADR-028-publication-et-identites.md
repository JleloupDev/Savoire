# ADR-028 — Publier Savoire : conteneurs, montée en charge, identités

## Statut

Proposé (04/11/2026). Étude de débroussaillage : rien n'est encore construit.
Les questions de la fin sont à trancher avant le premier chantier.

## Contexte

L'utilisateur veut publier l'application. Il pense à Docker, pour :
- ajouter facilement de nouvelles applications à la collection (web, API,
  pair indexeur, plus tard agents, boards publics...) ;
- gérer la montée en charge et le déploiement ;
- et il faut un système pour gérer les identités.

### Ce qui existe

**Conteneurs.** Trois images, construites depuis la racine du dépôt :

| Image | Dockerfile | Rôle |
|---|---|---|
| api | `backend/Savoire.API/Dockerfile` | Backend .NET 10, hubs SignalR, API REST |
| web | `apps/web/Dockerfile` | Appli React servie par nginx, qui relaie `/api` et `/hubs` |
| indexer | `apps/indexer/Dockerfile` | Pair indexeur (ADR-027), jamais exposé |

- `docker-compose.yml` : auto-hébergement sur une machine (`SELF_HOSTING.md`).
- `infra/*.bicep` + `azure.yaml` + `.github/workflows/deploy.yml` : déploiement
  de dev sur Azure Container Apps (azd), avec mise à zéro quand rien ne tourne.
  SQLite y est posé sur Azure Files, ce que l'ADR-027 déconseille (le verrou
  SQLite ne tient pas en SMB).
- `.github/workflows/indexer.yml` : construit et teste l'image du pair.

**Ce qui empêche d'avoir plusieurs instances de l'API :**
1. **SQLite** porte tout l'état du serveur : comptes, vaults, membres,
   registre des documents, et le journal CRDT (`operations_log`). C'est un
   fichier local, avec un seul écrivain à la fois.
2. **SignalR** garde ses groupes (un vault, un document, un canal d'index)
   en mémoire. Un message reçu par une instance n'atteint pas les clients
   branchés sur une autre.
3. Les pièces jointes passent déjà par un stockage d'objets (Azure Blob ou
   disque) : pas de blocage ici.
4. Le pair indexeur, lui, se répartit déjà sur plusieurs instances (hachage
   des vaults, ADR-027).

**Identités aujourd'hui.** Il y en a sept sortes, mêlées :

| Sorte | Où | Remarque |
|---|---|---|
| Comptes (connexion) | ASP.NET Identity dans SQLite, mot de passe chez Savoire | Jeton JWT signé par un secret partagé (HS256), jetons de rafraîchissement |
| « Continuer avec SSO » | `LoginPage.tsx` | Bouton sans branchement |
| Membres et rôles d'un vault | `vault_members`, `resource_permissions` | C'est de l'autorisation, propre à Savoire |
| Liens de partage, jetons de lecture | `share_links`, `ViewGrants` | Accès sans compte, limités |
| Identités cryptographiques | `vault_member_identities`, `IdentityController` | Clés de signature des membres (pair à pair, chiffré) |
| Service | `Indexer__ServiceToken` | Un secret partagé entre l'API et le pair |
| Bureau | `desktopConnection.ts` | Un compte serveur à la fois |

## Proposition

### 1. Conteneurs : une seule façon de livrer, trois tailles

Chaque application est une image. On publie les images, on ne reconstruit
jamais sur le serveur. Ajouter une application à la collection, c'est ajouter
une image et un bloc de déploiement.

**Étape A — maintenant, une machine.**
- La CI publie chaque image sur un registre (GHCR), étiquetée par version et
  par commit. Les mêmes images partout : dev, auto-hébergement, production.
- Un `docker-compose.prod.yml` : un proxy d'entrée avec HTTPS automatique
  (Caddy ou Traefik), les vérifications de santé, des volumes nommés et une
  sauvegarde de SQLite (copie à chaud, ou Litestream vers le stockage d'objets).
- C'est la cible de l'auto-hébergement, et ça suffit pour un premier public.

**Étape B — plusieurs instances de l'API.** C'est le vrai chantier, avant
tout orchestrateur :
- **PostgreSQL** à la place de SQLite pour le serveur (fournisseur EF Core
  Npgsql). SQLite reste possible pour l'auto-hébergement sur une machine,
  derrière la même configuration.
- **Fond de panier SignalR** (Redis, ou Azure SignalR Service sur Azure) :
  les groupes et les messages passent d'une instance à l'autre.
  Microsoft rappelle que les messages envoyés pendant une panne de Redis sont
  perdus : nos clients se rattrapent déjà à la reconnexion (`rejoinIndexes`,
  envoi de l'état complet), c'est donc acceptable.
- Affinité de session pour les WebSockets au proxy d'entrée.
- Le pair indexeur garde ses volumes, une instance par part de vaults.

**Étape C — orchestrateur.** Deux voies :
- **Kubernetes** (k3s chez un hébergeur européen, ou managé) avec un chart
  Helm unique « savoire ». Chaque application en est un sous-ensemble : api
  (réplicas), web, indexer (StatefulSet), fournisseur d'identité, PostgreSQL,
  Redis. Portable, c'est le standard pour une « collection d'applications ».
- **Azure Container Apps**, déjà en place : managé, montée en charge par
  KEDA, moins de travail d'exploitation, mais lié à Azure.

Recommandation : A tout de suite, B ensuite (c'est lui qui débloque la charge),
puis C sur Kubernetes. Une image Docker et des variables d'environnement
restent le seul contrat de chaque application, ce qui garde les trois voies
ouvertes.

### 2. Identités : séparer « qui êtes-vous » de « que pouvez-vous faire »

- **L'authentification part chez un fournisseur d'identité (IdP)** qui
  parle OpenID Connect. Savoire ne garde plus de mots de passe.
  - Le backend devient un « serveur de ressources » : il valide des jetons
    signés par l'IdP (RS256 ou ES256, clés publiées par JWKS) au lieu de son
    secret partagé.
  - Web et bureau : flux « Authorization Code + PKCE » (le bureau par une
    adresse de retour locale ou un lien profond).
  - Services (pair indexeur, futurs agents) : « client credentials » de l'IdP,
    à la place du jeton partagé `Indexer__ServiceToken`.
  - Connexion avec Google, Microsoft, GitHub, ou le SSO d'une entreprise :
    l'IdP s'en charge, Savoire n'a rien à coder par fournisseur.
- **L'autorisation reste dans Savoire** : vaults, rôles, partages, liens.
  Un compte Savoire est relié au sujet OIDC (`sub`) de l'IdP.
- **Les identités cryptographiques restent chez Savoire et chez les membres.**
  L'IdP ne voit jamais une clé privée. La clé de signature d'un membre est
  rattachée à son compte Savoire, donc à son `sub`.
- **L'auto-hébergement minimal** garde des comptes locaux, derrière la même
  interface : l'IdP est un module de plus, pas une obligation.

**Choix de l'IdP.** Tous s'auto-hébergent en conteneur :

| IdP | Licence | Pile | Points forts | Limites |
|---|---|---|---|---|
| Zitadel | AGPL-3.0 depuis la v3 (2025), API et SDK en Apache 2.0 | Go + PostgreSQL | Organisations natives (multi-tenant), léger, API complète | Obligations AGPL si on le modifie et le sert : sans effet pour un usage tel quel, compatible avec Savoire (AGPL) |
| Keycloak | Apache 2.0 | Java | Référence la plus déployée, très complet | Lourd, exploitation plus exigeante |
| Authentik | MIT (édition entreprise payante à part) | Python | Bon pour le SSO d'outils internes et les proxys | Moins pensé pour des clients grand public |
| Logto | MPL-2.0 (à vérifier) | TypeScript | Pages de connexion prêtes, organisations, rôles | Plus jeune |

Recommandation : **Zitadel**. Ses organisations natives collent à la cible
grand public multi-organisations (ADR-027 : pair hébergé par l'organisation
ou par Savoire). Il est léger et sa licence est compatible. Keycloak en
alternative. On n'utilise que de l'OIDC standard : l'IdP reste interchangeable.

**Migration des comptes existants.** Les mots de passe ASP.NET Identity sont
hachés en PBKDF2. On importe les comptes dans l'IdP. Si l'IdP choisi ne sait
pas reprendre ce format de hachage, chaque personne choisit un nouveau mot de
passe par un lien envoyé par courriel. À vérifier sur l'IdP retenu.

## Ordre proposé des chantiers

1. Images publiées par la CI, `docker-compose.prod.yml` avec HTTPS et
   sauvegardes (étape A).
2. Abstraction de l'authentification côté backend : validation de jetons
   OIDC (JWKS), à côté des comptes locaux ; IdP dans le compose.
3. Flux OIDC dans le web et le bureau ; jeton de service par client credentials.
4. PostgreSQL et fond de panier SignalR (étape B) ; test de charge à 2 instances.
5. Chart Helm et déploiement Kubernetes (étape C).

## Questions à trancher

1. Hébergement cible : Kubernetes chez un hébergeur (lequel ?), ou garder
   Azure Container Apps ?
2. IdP : Zitadel (recommandé) ou Keycloak ?
3. Accord pour les dépendances de l'étape B : `Npgsql.EntityFrameworkCore.PostgreSQL`,
   `Microsoft.AspNetCore.SignalR.StackExchangeRedis`, et l'image de l'IdP.
4. Comptes locaux : les garder pour l'auto-hébergement minimal ?
5. Connexions sociales à proposer dès le départ (Google, Microsoft, GitHub) ?

## Sources

- Zitadel, licence AGPL depuis la v3 : https://zitadel.com/blog/zitadel-vs-keycloak
- Comparatifs 2026 : https://skycloak.io/blog/open-source-authentication-comparison-2026/,
  https://www.authgear.com/post/best-open-source-identity-providers
- Fond de panier Redis pour SignalR : https://learn.microsoft.com/aspnet/core/signalr/redis-backplane
