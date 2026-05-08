import {serve} from "bun";
import {join} from "node:path";
import {server as binaryServer} from "@browser-agent-os/host-bun";
import {buildBundles, browserHandler} from "./server.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const COREUTILS = join(ROOT, "packages", "coreutils", "zig-out", "bin");
const SHELL = join(ROOT, "packages", "shell", "zig-out", "bin");

const bundles = await buildBundles();
const bins = binaryServer({binariesDirs: [COREUTILS, SHELL]});
const browser = browserHandler(bundles);

const listener = serve({
    port: Number(process.env.PORT ?? 3000),
    fetch: req => {
        const url = new URL(req.url);
        if (url.pathname.startsWith("/bin/")) return bins(req);
        return browser(req);
    },
});

console.log(`browser-agent-os browser host on ${listener.url}`);
console.log(`  binaries from ${COREUTILS} and ${SHELL}`);
