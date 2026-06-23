<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- SPDX-FileCopyrightText: 2026 Jean Leloup -->

# edgesync-protocol (POC)

Protocole **pair-à-pair** d'édition collaborative, **chiffré de bout en bout et
signé**, **agnostique au transport et au CRDT**. Chaque participant est un `Peer`
qui tourne cette même lib. Le serveur n'en fait pas partie : s'il existe, c'est un
*peer headless* ou un *provider de clés* — injecté de l'extérieur.

- Modèle de confiance & de clés : [../../docs/Architecture/security-channel-model.md](../../docs/Architecture/security-channel-model.md)
- Design & schémas : [../../docs/Architecture/edgesync-protocol.md](../../docs/Architecture/edgesync-protocol.md)
- Référence du protocole de fil : [../../docs/Architecture/edgesync-wire-protocol.md](../../docs/Architecture/edgesync-wire-protocol.md)
- Décisions : [../../docs/Architecture/adr/](../../docs/Architecture/adr/)

## Lancer

```bash
npm install
npm test          # batterie complète (vitest)
npm run typecheck # tsc --noEmit (strict)
```

## Architecture (hexagonale)

```
src/
  core/      identity.ts  envelope.ts  keyring.ts            # pur, sans I/O
  ports/     crdt.ts  transport.ts  peer-store.ts  storage.ts # interfaces
  adapters/  yjs-crdt.ts  in-process-transport.ts  websocket-transport.ts
             in-memory-storage.ts  filesystem-storage.ts
  protocol/  messages.ts  session.ts  persistence.ts         # orchestrateur + persistance
```

Le cœur ne connaît ni Yjs ni le réseau. `Session` câble le tout :
*local update → encrypt(époque) → sign → frame → transport* ; en réception
*route → verify → decrypt → applyRemote*.

## Ce que la batterie prouve

| Test | Vérifie |
|---|---|
| `envelope.test.ts` | primitives pures : AEAD, sealed-box, enveloppe, signature |
| `keyring.test.ts` | enveloppe `K_vault→K_doc`, rotation, historique, **partage de note** |
| `session.inproc.test.ts` (a+b) | le fil ne porte **que du chiffré** ; deux pairs **convergent** |
| `session.inproc.test.ts` (c) | **rotation** : un pair offline re-key à la reconnexion et **merge** |
| `session.inproc.test.ts` (d) | un **révoqué** ne lit plus le futur ; sa poussée périmée est **rejetée** |
| `session.inproc.test.ts` (d2) | une op forgée en `SYNC_RESP` vieux-époque est **rejetée** (anti-contournement) |
| `session.inproc.test.ts` (b1) | une op signée d'une **identité inconnue** est **rejetée** |
| `websocket.e2e.test.ts` (e) | sync E2E sur un **vrai WebSocket entre deux process séparés** |
| `persistence.test.ts` | restaure identité + keyring + contenu ; **contenu en ciphertext au repos** (mémoire & disque) |

## Intégration dans l'app

Le protocole est agnostique. Pour le baser dessus, l'app remplit : un adaptateur
`ITransport` (réseau réel), un adaptateur `IStorage` qui **chiffre les blobs
`secret/`** au repos, le canal hors-bande (si S4), et la **composition d'un vault**
(une `Session` par ressource : répertoire + une par note). Contrat détaillé et
périmètre v0 : [ADR-0013](../../docs/Architecture/adr/0013-perimetre-v0-mvp.md).

## Simplifications v0 (assumées, à lever ensuite)

- **Époques vault et doc avancées ensemble.** La rotation indépendante par note
  (forward-revoke d'une seule note) est différée. La structure (K_doc wrappée, pas
  dérivée) la permet déjà.
- **Révocation sans liste de révocation.** Un `granting=true` accorde la clé à tout
  pair qui (re)dit `HELLO`. Pour qu'une révocation tienne face à une reconnexion du
  révoqué, il faudra une liste de révocation côté détenteur de clés.
- **Persistance via port `IStorage`** (mémoire + filesystem). Le **chiffrement au
  repos est délégué à l'app** ([ADR-0011](../../docs/Architecture/adr/0011-persistance-port-istorage.md)) :
  le protocole stocke le contenu en **ciphertext** (jamais en clair au repos) ; seuls
  les blobs `secret/` (identité, keyring) attendent un adaptateur chiffrant en prod.
  Le *quand* persister reste au choix de l'app (`Session.persist()`).
- **Identité en TOFU (S3)** — épinglage au premier `HELLO`, **vulnérable à un MITM
  actif au premier contact**. Vérification hors-bande (empreinte + `verify()` → S4)
  et transparence de clé : conçues, **non implémentées** ([ADR-0012](../../docs/Architecture/adr/0012-verification-hors-bande-differee.md)).
- **Transport WebSocket point-à-point** (un écoute, l'autre compose). Multi-pair et
  WebRTC/libp2p = nouveaux adaptateurs `ITransport`, protocole inchangé.
- **Capacités seules** (pas d'op-log ACL, pas d'ordre faisant autorité — [ADR-0010](../../docs/Architecture/adr/0010-ordre-faisant-autorite-differe.md)).
