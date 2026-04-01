export function bytesToBase64(bytes) {
    if (typeof btoa !== 'function')
        throw new Error('btoa is not available in this runtime');
    let binary = '';
    for (const b of bytes)
        binary += String.fromCharCode(b);
    return btoa(binary);
}
export function base64ToBytes(base64) {
    if (typeof atob !== 'function')
        throw new Error('atob is not available in this runtime');
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++)
        out[i] = binary.charCodeAt(i);
    return out;
}
//# sourceMappingURL=base64.js.map