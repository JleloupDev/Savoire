import { jsx as _jsx } from "react/jsx-runtime";
// ui-components must not depend on editor internals.
export function Button({ variant = 'default', size = 'md', style, ...props }) {
    const sizeStyles = {
        sm: { padding: '2px 8px', fontSize: 12 },
        md: { padding: '4px 12px', fontSize: 14 },
        lg: { padding: '8px 16px', fontSize: 16 },
    }[size];
    const variantStyles = {
        default: { background: '#f0f0f0', border: '1px solid #ccc', color: '#333' },
        ghost: { background: 'transparent', border: 'none', color: 'inherit' },
        primary: { background: '#5865f2', border: 'none', color: '#fff' },
    }[variant];
    return (_jsx("button", { ...props, style: {
            cursor: 'pointer',
            borderRadius: 4,
            ...sizeStyles,
            ...variantStyles,
            ...style,
        } }));
}
//# sourceMappingURL=Button.js.map