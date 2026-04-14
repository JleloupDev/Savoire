# ADR-003 — Share Link Token Design

## Status
Accepted

## Context
Share links need a token that is unguessable, URL-safe, and simple to look up. Options include hashed tokens (bcrypt), signed tokens (JWT), or plain random tokens.

## Decision
Tokens are **32 random bytes encoded as URL-safe base64** (43 characters), stored as plain text in the database. No hashing, no signing.

The brute-force search space is 2^256. At 10^9 guesses/second, exhausting it would take ~10^68 years. Hashing adds infrastructure complexity with no security benefit at this scale.

## Consequences
- Token lookup is a simple equality check — O(1), no bcrypt overhead.
- No token revocation complexity (plain comparison).
- If the database is compromised, tokens are exposed directly. Acceptable given tokens grant limited read-only access and can be revoked by deleting the row.
