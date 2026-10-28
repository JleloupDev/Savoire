# ADR-027 — Base de données : CRDT pour la vérité, SQLite pour l'index, un pair indexeur

## Statut
Accepté (28/10/2026). Plan détaillé : étude du 27-28/10/2026.

## Contexte
Savoire doit offrir des bases façon Notion et, plus largement, un moteur de requêtes (recherche, propriétés, liens, graphe) qui marche :

1. en local sur des fichiers téléchargés (appli de bureau) **et** dans le navigateur ;
2. sur des vaults de plus de 10 000 notes ;
3. sur des bases larges (100 000 lignes et plus) ;
4. en pair à pair, chiffrement de bout en bout compris.

Un client web ne peut pas télécharger 10 000 notes pour les indexer. Aujourd'hui, rien ne parcourt le vault : une note n'a d'entrées d'index qu'une fois ouverte dans un éditeur ; le plein texte (MiniSearch) est local et partiel ; le serveur ne lit jamais le contenu et n'a aucune route de recherche.

Aucune base « CRDT + requêtes + pair à pair + navigateur + libre et vivante » n'existe clé en main (octobre 2026) : cr-sqlite est arrêté depuis janvier 2024 ; Evolu impose sa synchro ; Jazz v2 (alpha) abandonne le CRDT et le chiffrement ; LiveStore, ElectricSQL, PowerSync, Zero et TanStack DB font autorité côté serveur ; TinyBase est en mémoire ; PGlite est lourd ; Loro et Automerge sont d'excellents CRDT sans moteur de requête.

## Décision
1. **La vérité reste dans les CRDT Yjs** (documents, propriétés en frontmatter, manifestes de bases et lots de lignes en `ISharedTree`).
2. **Les requêtes passent par un index SQLite dérivé**, jamais synchronisé, toujours reconstructible depuis les documents. Le contrat `IQueryEngine` (`packages/plugin-api/src/query.ts`) est déclaratif : aucun SQL ne vient d'un client ni d'un plugin.
3. **Un pair indexeur** : un service qui se connecte au vault comme un membre en lecture, calcule l'index avec le même code TypeScript que les clients, et répond aux requêtes des clients légers. Il est hébergé au choix de l'organisation :
   - par l'équipe Savoire (mode serveur, ou mode chiffré si l'organisation lui confie la clé) ;
   - par l'organisation elle-même, avec la clé du vault ; le serveur Savoire reste aveugle.
   Un réglage du vault désigne le pair qui le sert. Les demandeurs s'authentifient par leur identité de membre.
4. **Le même index tourne aussi chez les clients complets** : SQLite natif sur le bureau, SQLite WebAssembly (OPFS) dans le navigateur, alimentés par les fichiers ou par un index partagé compacté (instantané + deltas).

## Exigences sur le pair indexeur
- Service de premier rang : conteneur dédié, configuration explicite, santé (`/health/live`, `/health/ready`), métriques par vault et globales, schéma d'index versionné (reconstruction en arrière-plan puis bascule).
- Cible grand public : vaults répartis entre instances (hachage cohérent), un SQLite par vault (mode WAL), priorités (requêtes > mises à jour > constructions), regroupement des modifications d'une note, cache de résultats invalidé par la séquence de l'index, limitation de débit par utilisateur et par vault, plafonds par requête.
- Sécurité : droits vérifiés à chaque requête ; un lien de partage n'interroge que sa note ; isolation par fichier de vault ; le pair ne croit que les documents, jamais les entrées publiées par les clients ; non exposé, jeton de service ; purge à la corbeille et à la suppression.
- Dégradé : l'édition n'en dépend jamais ; recherche et bases basculent sur l'index partagé avec un état visible ; reprise depuis la dernière séquence traitée.

## Les pouvoirs du pair indexeur (décision du 28/10/2026)
Le pair indexeur n'est pas qu'un moteur de bases : c'est le service de connaissance de toute l'appli. Il lit tout le vault, en continu, avec le code des clients. Tout ce qui demande « tout le vault » passe par lui.

Il est donc construit comme un **hôte de pouvoirs** (« capacités ») : chaque pouvoir déclare ses tables dans le SQLite du vault, ce qu'il extrait d'une note, et ses méthodes. Le backend relaie un appel `capacité.méthode` sans le connaître (droits, débit, routage), donc un nouveau pouvoir ne demande aucun changement du backend. Les mêmes pouvoirs tournent chez les clients complets (bureau, navigateur).

Pouvoirs de la première version :
- `query` : les requêtes déclaratives (`IQueryEngine`), pour les bases, les listes et les propriétés ;
- `search` : la recherche plein texte avec extraits et surlignage (`ISearchEngine`), dans un vault et **globale** sur tous les vaults de la personne ;
- `links` : rétroliens, liens sortants, liens non résolus, graphe ;
- `tags` : liste des tags et notes par tag ;
- `index` : état de l'index (construction, retard, taille).

Pouvoirs prévus, sur le même modèle : texte des pièces jointes (PDF, OCR), recherche sémantique (vecteurs), doublons et notes orphelines, rappels sur les dates des propriétés, contexte pour les agents IA, statistiques du vault, abonnements « préviens-moi quand cette requête change ».

Contrat technique : `docs/Architecture/indexer-protocol.md`.

## Conséquences
- Pas de remplacement de Yjs ni de la synchro existante.
- Dépendances à faire valider le moment venu : `node:sqlite` (intégré à Node) ou une bibliothèque SQLite pour Node, `@sqlite.org/sqlite-wasm`, `rusqlite`.
- Le pair d'organisation (mode chiffré) attend la reprise du profil chiffré (EdgeSync, gelé) ; les points d'accroche (réglage du vault, authentification des demandeurs) sont posés dès le pair géré.
- Étapes : contrats → noyau d'indexation partagé → pair indexeur serveur → propriétés typées → plugin Bases → SQLite côté clients → lignes légères en lots → index partagé compacté → pair d'organisation.
