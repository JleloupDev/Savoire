import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Button } from './Button';
export function Modal({ open, title, onClose, children }) {
    if (!open)
        return null;
    return (_jsx("div", { style: {
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
        }, onClick: onClose, children: _jsxs("div", { style: {
                background: '#fff',
                borderRadius: 8,
                padding: 24,
                minWidth: 320,
                boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
            }, onClick: (e) => e.stopPropagation(), children: [title && (_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 16 }, children: [_jsx("strong", { children: title }), _jsx(Button, { variant: "ghost", size: "sm", onClick: onClose, children: "\u2715" })] })), children] }) }));
}
//# sourceMappingURL=Modal.js.map