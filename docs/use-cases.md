# Use cases — Application layer

Source: `packages/application/src/contracts.ts`

---

## Auth

| Use case | Method |
|---|---|
| Login | `auth.login(email, password)` |
| Refresh token | `auth.refresh(refreshToken)` |
| Logout | `auth.logout(accessToken, refreshToken)` |
| Change password | `auth.changePassword(token, currentPassword, newPassword)` |

---

## Vaults

| Use case | Method |
|---|---|
| List vaults and shared documents | `vaults.list(userId, token)` |
| Create vault | `vaults.create(userId, name, token)` |
| Rename vault | `vaults.rename(vaultId, name, token)` |
| Delete vault | `vaults.delete(vaultId, token)` |

---

## Documents

| Use case | Method |
|---|---|
| Activate vault (connect, enable collaboration) | `documents.activateVault(params)` |
| Activate a shared document (no vault membership) | `documents.activateSharedDocument(params)` |
| List documents in a vault | `documents.list(vaultId, token)` |
| Dispose active vault | `documents.disposeActiveVault()` |

---

## Document session

| Use case | Method |
|---|---|
| Open a document for editing | `documentSession.open(vaultId, docId, metadata, token)` |
| Close a document | `documentSession.close(vaultId, docId)` |
| Read document content | `documentSession.read(vaultId, docId, token)` |

---

## Sharing

| Use case | Method |
|---|---|
| Get sharing state of a resource | `sharing.getSharing(resourceType, id, token)` |
| Grant permission to a user | `sharing.grantPermission(resourceType, id, subjectId, permission, token)` |
| Revoke permission from a user | `sharing.revokePermission(resourceType, id, targetUserId, token)` |
| Lookup user by email | `sharing.lookupUserByEmail(email, token)` |
| Create share link | `sharing.createShareLink(resourceType, id, permission, token)` |
| Revoke share link | `sharing.revokeShareLink(linkId, token)` |
| Access a share link (redeem) | `sharing.accessShareLink(shareToken)` |

---

## Admin

| Use case | Method |
|---|---|
| List all users | `admin.listUsers(token)` |
| Create user | `admin.createUser(token, email, password, displayName, isAdmin)` |
| Reset user password | `admin.resetPassword(token, userId, newPassword)` |
| Revoke user sessions | `admin.revokeSessions(token, userId)` |
| Disable user | `admin.disableUser(token, userId)` |

---

## Workspace

| Use case | Method |
|---|---|
| Create a VaultAPI proxy over the active client | `workspace.createVaultProxy(getClient, resolveDocId)` |
