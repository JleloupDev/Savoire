// Tells React that this environment supports act() — suppresses spurious warnings
// from react-dom and react-router-dom when running under vitest/happy-dom.
// @ts-expect-error — globalThis typing does not include this React-internal flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true
