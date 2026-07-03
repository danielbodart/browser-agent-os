import {join} from "node:path";
import {bundle, type Http} from "@browser-agent-os/host-bun";

const ROOT = join(import.meta.dir, "..");
const PAGE_ENTRY = join(ROOT, "src", "app.ts");
const HTML_FILE = join(ROOT, "src", "index.html");

const KERNEL_ROOT = join(ROOT, "..", "kernel");
const JSPI_RUNNER_ENTRY = join(KERNEL_ROOT, "src", "worker", "runner.jspi.web.ts");
const OPFS_RUNNER_ENTRY = join(KERNEL_ROOT, "src", "fs", "runner.opfs.web.ts");

const XTERM_CSS = join(ROOT, "node_modules", "@xterm", "xterm", "css", "xterm.css");

export interface Bundles {
    readonly html: string;
    readonly app: string;
    readonly jspiRunner: string;
    readonly opfsRunner: string;
    readonly xtermCss: string;
}

export async function buildBundles(): Promise<Bundles> {
    // `bundle` serialises builds process-wide, so these run one at a time even
    // inside Promise.all; the two file reads still overlap freely.
    const [html, app, jspiRunner, opfsRunner, xtermCss] = await Promise.all([
        Bun.file(HTML_FILE).text(),
        bundle(PAGE_ENTRY, "app"),
        bundle(JSPI_RUNNER_ENTRY, "jspi runner"),
        bundle(OPFS_RUNNER_ENTRY, "opfs runner"),
        Bun.file(XTERM_CSS).text(),
    ]);
    return {html, app, jspiRunner, opfsRunner, xtermCss};
}

export function browserHandler(bundles: Bundles): Http {
    return async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/" || url.pathname === "/index.html") {
            return new Response(bundles.html, {headers: {"content-type": "text/html; charset=utf-8"}});
        }
        if (url.pathname === "/app.js") {
            return new Response(bundles.app, {headers: {"content-type": "application/javascript"}});
        }
        if (url.pathname === "/runner.jspi.web.js") {
            return new Response(bundles.jspiRunner, {headers: {"content-type": "application/javascript"}});
        }
        if (url.pathname === "/runner.opfs.web.js") {
            return new Response(bundles.opfsRunner, {headers: {"content-type": "application/javascript"}});
        }
        if (url.pathname === "/xterm.css") {
            return new Response(bundles.xtermCss, {headers: {"content-type": "text/css"}});
        }
        return new Response("Not Found", {status: 404});
    };
}
