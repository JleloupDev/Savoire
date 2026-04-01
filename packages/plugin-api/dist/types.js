// Public plugin API — plugins must only depend on this package.
// No dependency on editor-core internals allowed.
//
// This file is a re-export barrel. Import from the specific sub-modules
// for better tree-shaking, or from here for convenience.
export * from './manifest';
export * from './commands';
export * from './hooks';
export * from './blocks';
export * from './vault';
export * from './workspace';
export * from './editor';
export * from './triggers';
export * from './sync';
export * from './indexing';
export * from './files';
export * from './views';
export * from './plugin-api';
//# sourceMappingURL=types.js.map