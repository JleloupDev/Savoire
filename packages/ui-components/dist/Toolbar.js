import { jsx as _jsx } from "react/jsx-runtime";
export function Toolbar({ children, style }) {
    return (_jsx("div", { style: {
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 8px',
            borderBottom: '1px solid #e0e0e0',
            ...style,
        }, children: children }));
}
//# sourceMappingURL=Toolbar.js.map