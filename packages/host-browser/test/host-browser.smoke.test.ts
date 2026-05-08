import {describe, it, expect, beforeAll, afterAll} from "bun:test";
import {serve} from "bun";
import {chromium, type Browser, type BrowserContext, type Page} from "playwright";
import {join} from "node:path";
import {server as binaryServer} from "@browser-agent-os/host-bun";
import {buildBundles, browserHandler} from "../src/server.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const COREUTILS = join(ROOT, "packages", "coreutils", "zig-out", "bin");
const SHELL = join(ROOT, "packages", "shell", "zig-out", "bin");

let listener: ReturnType<typeof serve>;
let browser: Browser;

beforeAll(async () => {
    const bundles = await buildBundles();
    const browserH = browserHandler(bundles);
    const bins = binaryServer({binariesDirs: [COREUTILS, SHELL]});
    listener = serve({
        port: 0,
        fetch: req => {
            const url = new URL(req.url);
            if (url.pathname.startsWith("/bin/")) return bins(req);
            return browserH(req);
        },
    });
    browser = await chromium.launch({headless: true});
}, 60_000);

afterAll(async () => {
    try { await browser?.close(); } catch {}
    listener?.stop(true);
}, 30_000);

async function freshPage(): Promise<{ctx: BrowserContext; page: Page}> {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("pageerror", err => console.error("[pageerror]", err.message, err.stack));
    page.on("console", msg => {
        if (msg.type() === "error") console.error("[browser console]", msg.text());
    });
    return {ctx, page};
}

async function clearOpfsAndReload(page: Page): Promise<void> {
    await page.goto(listener.url.toString(), {waitUntil: "load"});
    await page.evaluate(async () => {
        const root = await (navigator as unknown as {storage: {getDirectory: () => Promise<FileSystemDirectoryHandle>}}).storage.getDirectory();
        for await (const name of (root as unknown as {keys: () => AsyncIterable<string>}).keys()) {
            await root.removeEntry(name, {recursive: true});
        }
    });
    await page.reload({waitUntil: "load"});
    await waitForShell(page);
}

async function waitForShell(page: Page): Promise<void> {
    await page.waitForFunction(() => (window as unknown as {__shellReady?: boolean}).__shellReady === true, null, {timeout: 30_000});
}

async function sendLine(page: Page, line: string): Promise<void> {
    await page.evaluate(l => (window as unknown as {__sendLine: (s: string) => void}).__sendLine(l), line);
}

async function waitForOutput(page: Page, pattern: RegExp, timeout = 15_000): Promise<string> {
    await page.waitForFunction(
        re => {
            const text = (window as unknown as {__terminalText: () => string}).__terminalText();
            return new RegExp(re).test(text);
        },
        pattern.source,
        {timeout},
    );
    return page.evaluate(() => (window as unknown as {__terminalText: () => string}).__terminalText());
}

describe("host-browser smoke", () => {
    it("echo hello | cat -> 'hello' on screen", async () => {
        const {ctx, page} = await freshPage();
        try {
            await clearOpfsAndReload(page);
            await sendLine(page, "echo hello | cat");
            const out = await waitForOutput(page, /hello/);
            expect(out).toContain("hello");
        } finally {
            await ctx.close();
        }
    }, 60_000);

    it("ls lists files written via redirect", async () => {
        const {ctx, page} = await freshPage();
        try {
            await clearOpfsAndReload(page);
            await sendLine(page, "echo first > /a.txt");
            await sendLine(page, "ls /");
            const out = await waitForOutput(page, /a\.txt/);
            expect(out).toContain("a.txt");
        } finally {
            await ctx.close();
        }
    }, 60_000);

    it("OPFS persistence across reload", async () => {
        const {ctx, page} = await freshPage();
        try {
            await clearOpfsAndReload(page);
            // Write file, then `ls /` to confirm it's on disk before reload.
            await sendLine(page, "echo persisted > /persist.txt");
            await sendLine(page, "ls /");
            await waitForOutput(page, /persist\.txt/);
            // Reload — fresh shell + fresh OPFS instance, file must remain.
            await page.reload({waitUntil: "load"});
            await waitForShell(page);
            await sendLine(page, "cat /persist.txt");
            const out = await waitForOutput(page, /persisted/);
            expect(out).toContain("persisted");
        } finally {
            await ctx.close();
        }
    }, 90_000);
});
