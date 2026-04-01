// ─── Plugin API surface ───────────────────────────────────────────────────
//
// Two ports are exposed by the application layer (both implemented by PluginAPIImpl):
//   - PluginAPI        → restricted interface received by plugins
//   - IEditorHostAPI   → privileged interface received by EditorCore as host
//
// Defined here so editor-core can import without depending on plugin-runtime.
export {};
//# sourceMappingURL=plugin-api.js.map