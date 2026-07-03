import {join} from "node:path";
import {bundle} from "../../src/bundle.ts";
import type {Http} from "../../src/server.ts";

interface Bundles {
    readonly page: string;
    readonly worker: string;
}

async function buildBundles(): Promise<Bundles> {
    const root = join(import.meta.dir, "..", "..", "..", "..");
    const pageEntry = join(root, "packages", "host-bun", "test", "opfs", "page.ts");
    const workerEntry = join(root, "packages", "host-bun", "test", "opfs", "worker-entry.ts");

    const page = await bundle(pageEntry, "opfs page");
    const worker = await bundle(workerEntry, "opfs worker");
    return {page, worker};
}

const HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>opfs test</title></head>
<body><h1>OpfsFs contract</h1><pre id="results">running...</pre>
<script type="module" src="/page.js"></script>
</body></html>`;

export async function opfsTestServer(): Promise<Http> {
    const bundles = await buildBundles();
    return async (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/' || url.pathname === '/index.html') {
            return new Response(HTML, {headers: {"content-type": "text/html"}});
        }
        if (url.pathname === '/page.js') {
            return new Response(bundles.page, {headers: {"content-type": "application/javascript"}});
        }
        if (url.pathname === '/opfs-worker.js') {
            return new Response(bundles.worker, {headers: {"content-type": "application/javascript"}});
        }
        return new Response("Not Found", {status: 404});
    };
}
