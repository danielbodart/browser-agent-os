// Absolute, POSIX-style path utilities. No symlinks. Never escapes root.

export function normalize(path: string): string {
    if (!path.startsWith('/')) throw new Error(`absolute path required, got "${path}"`);
    const parts = path.split('/').filter(p => p.length > 0 && p !== '.');
    const out: string[] = [];
    for (const p of parts) {
        if (p === '..') {
            if (out.length > 0) out.pop();
            continue;
        }
        out.push(p);
    }
    return '/' + out.join('/');
}

export function resolve(base: string, rel: string): string {
    if (rel.startsWith('/')) return normalize(rel);
    const baseNorm = normalize(base);
    const joined = baseNorm === '/' ? `/${rel}` : `${baseNorm}/${rel}`;
    return normalize(joined);
}

export function dirname(path: string): string {
    const n = normalize(path);
    if (n === '/') return '/';
    const i = n.lastIndexOf('/');
    return i === 0 ? '/' : n.slice(0, i);
}

export function basename(path: string): string {
    const n = normalize(path);
    if (n === '/') return '';
    const i = n.lastIndexOf('/');
    return n.slice(i + 1);
}

export function split(path: string): readonly string[] {
    const n = normalize(path);
    if (n === '/') return [];
    return n.slice(1).split('/');
}
