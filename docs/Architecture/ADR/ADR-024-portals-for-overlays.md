# ADR-024 — Editor Overlays Rendered via createPortal into document.body

## Status
Accepted

## Context
Dockview (the panel layout library) applies CSS `transform` properties to its panel containers for positioning. Any element with `position: fixed` or `position: absolute` that is a descendant of a transformed ancestor loses its fixed positioning — it is positioned relative to the transformed container, not the viewport.

The slash menu (`TriggerOverlay`) and the bubble toolbar (`BubbleToolbar`) must appear at precise viewport coordinates above all panel content.

## Decision
All editor overlays use **`ReactDOM.createPortal`** to render into `document.body`, outside the Dockview panel hierarchy. Their position is computed from the editor's cursor coordinates (via `EditorPositionAPI`) and applied as inline `top`/`left` styles.

The overlay is positioned above or below the trigger line depending on available viewport space.

## Consequences
- Overlays are unaffected by any ancestor CSS transforms.
- Overlays render correctly regardless of which Dockview panel contains the editor.
- Z-index management is explicit — overlays must have a z-index high enough to appear above all other panels.
- Clicking outside the overlay to dismiss it requires a document-level click listener, not a React `onBlur` event.
