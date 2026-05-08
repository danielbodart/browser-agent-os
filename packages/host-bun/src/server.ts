import {join, normalize} from "node:path";

export type Http = (request: Request) => Promise<Response>;

export interface ServerOptions {
    readonly binariesDir: string;
}

export function server({binariesDir}: ServerOptions): Http {
    return async (request) => {
        const url = new URL(request.url);
        if (!url.pathname.startsWith("/bin/")) {
            return new Response("Not Found", {status: 404});
        }
        const binary = url.pathname.slice("/bin/".length);
        const safe = normalize(binary);
        if (safe.startsWith("..") || safe.includes("/")) {
            return new Response("Bad Request", {status: 400});
        }
        const path = join(binariesDir, `${safe}.wasm`);
        const file = Bun.file(path);
        if (!(await file.exists())) {
            return new Response(`No such binary: ${safe}`, {status: 404});
        }
        return new Response(file, {
            headers: {
                "content-type": "application/wasm",
                "cache-control": "no-store",
            },
        });
    };
}
