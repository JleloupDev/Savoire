export class WorkspaceService {
    createVaultProxy(getClient, resolveDocId) {
        return {
            read: (documentId) => getClient()?.read(documentId) ?? Promise.resolve(''),
            readDocumentByPath: (path) => getClient()?.readDocumentByPath(path) ?? Promise.resolve(''),
            write: (documentId, content) => getClient()?.write(documentId, content) ?? Promise.resolve(),
            list: (dir) => getClient()?.list(dir) ?? Promise.resolve([]),
            exists: (documentId) => getClient()?.exists(documentId) ?? Promise.resolve(false),
            resolveDocumentId: (path) => resolveDocId(path),
            getVaultId: () => getClient()?.getVaultId() ?? '',
            getToken: () => getClient()?.getToken() ?? '',
            createFile: (path) => getClient()?.createFile?.(path) ?? Promise.resolve(),
            createFolder: (path) => getClient()?.createFolder?.(path) ?? Promise.resolve(),
            renameFile: (documentId, newPath) => getClient()?.renameFile?.(documentId, newPath) ?? Promise.resolve(),
            deleteFile: (documentId) => getClient()?.deleteFile?.(documentId) ?? Promise.resolve(),
            deleteFolder: (path) => getClient()?.deleteFolder?.(path) ?? Promise.resolve(),
            uploadAttachment: (file) => getClient()?.uploadAttachment?.(file) ?? Promise.reject(new Error('No active vault')),
            resolveAttachmentUrl: (path) => getClient()?.resolveAttachmentUrl?.(path) ?? '',
        };
    }
}
//# sourceMappingURL=WorkspaceService.js.map