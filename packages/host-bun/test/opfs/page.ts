import {OpfsFs, type OpfsFsBackend} from "@browser-agent-os/kernel";
import {FS_CASES, writeAll, readAll} from "../fs.contract.ts";

interface PageResult {
    name: string;
    passed: boolean;
    message?: string;
}

function makeBackend(workerUrl: string): OpfsFsBackend {
    const worker = new Worker(workerUrl, {type: 'module'});
    worker.addEventListener('error', e => console.error('[fs-worker error]', (e as ErrorEvent).message, (e as ErrorEvent).filename, (e as ErrorEvent).lineno));
    worker.addEventListener('messageerror', e => console.error('[fs-worker messageerror]', e));
    return {
        postMessage(msg) { worker.postMessage(msg); },
        addReplyListener(handler) {
            worker.addEventListener('message', e => handler((e as MessageEvent).data));
        },
    };
}

async function clearOpfs(): Promise<void> {
    const root = await (navigator as any).storage.getDirectory() as FileSystemDirectoryHandle;
    for await (const name of (root as any).keys() as AsyncIterable<string>) {
        await root.removeEntry(name, {recursive: true});
    }
}

async function runContract(workerUrl: string): Promise<PageResult[]> {
    const out: PageResult[] = [];
    for (const c of FS_CASES) {
        await clearOpfs();
        const fs = new OpfsFs(makeBackend(workerUrl));
        try {
            await c.run(fs);
            out.push({name: c.name, passed: true});
        } catch (e) {
            out.push({name: c.name, passed: false, message: (e as Error).message});
        }
    }
    return out;
}

async function persistenceCase(workerUrl: string): Promise<PageResult> {
    await clearOpfs();
    try {
        // Process A: write
        const fsA = new OpfsFs(makeBackend(workerUrl));
        const enc = new TextEncoder();
        await writeAll(fsA, "/persist.txt", enc.encode("persisted\n"));

        // Process B: fresh backend, read
        const fsB = new OpfsFs(makeBackend(workerUrl));
        const dec = new TextDecoder();
        const got = dec.decode(await readAll(fsB, "/persist.txt"));
        if (got !== "persisted\n") throw new Error(`expected "persisted\\n", got ${JSON.stringify(got)}`);
        return {name: "persistence across respawn", passed: true};
    } catch (e) {
        return {name: "persistence across respawn", passed: false, message: (e as Error).message};
    }
}

(async () => {
    try {
        const params = new URLSearchParams(window.location.search);
        const workerUrl = params.get('worker') ?? '/opfs-worker.js';
        const results = [...await runContract(workerUrl), await persistenceCase(workerUrl)];
        (window as any).__results = results;
        document.title = 'done';
        const pre = document.getElementById('results') as HTMLPreElement;
        if (pre) pre.textContent = JSON.stringify(results, null, 2);
    } catch (e) {
        console.error('page.js fatal', (e as Error).message, (e as Error).stack);
        (window as any).__results = [{name: 'bootstrap', passed: false, message: (e as Error).message}];
        document.title = 'done';
    }
})();
