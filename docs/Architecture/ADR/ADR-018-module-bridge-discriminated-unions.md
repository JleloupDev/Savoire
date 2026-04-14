# ADR-018 — Module Bridge Protocol via Typed Discriminated Unions

## Status
Accepted

## Context
The module plugin loads external content in an iframe and communicates with the host app via `postMessage`. Without a defined message schema, both sides must handle arbitrary objects and rely on runtime checks.

## Decision
All bridge messages are **typed discriminated unions** in TypeScript:

```ts
type BridgeMessage =
  | { type: 'vault:read'; path: string }
  | { type: 'vault:read:response'; content: string }
  | { type: 'vault:write'; path: string; content: string }
  | ...
```

Both the host (`VaultHostBridge`) and the iframe (`IframeVaultAPI`) switch on `message.type`. Unknown message types are ignored.

The initial vault snapshot is passed in the first `load` message to eliminate a round-trip `vault:readByPath` call on module startup.

## Consequences
- Both sides of the bridge have full TypeScript type safety.
- Adding a new message type requires changes in `protocol.ts` only — both sides get compile errors if they don't handle it.
- The protocol is an internal contract; external modules loaded by users must conform to it or their vault calls will silently fail.
