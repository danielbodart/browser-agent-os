import {describe, it, expect, beforeAll, afterAll} from "bun:test";
import {serve} from "bun";
import {chromium, type Browser} from "playwright";
import {opfsTestServer} from "./opfs/opfsServer.ts";

interface PageResult {
    name: string;
    passed: boolean;
    message?: string;
}

let listener: ReturnType<typeof serve>;
let browser: Browser;
let results: PageResult[] | null = null;
let runError: string | null = null;

beforeAll(async () => {
    const handler = await opfsTestServer();
    listener = serve({port: 0, fetch: handler});
    browser = await chromium.launch({headless: true});

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const consoleLog: string[] = [];
    page.on('console', msg => consoleLog.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', err => consoleLog.push(`[pageerror] ${err.message}\n${err.stack ?? ''}`));

    try {
        await page.goto(listener.url.toString(), {waitUntil: 'load'});
        await page.waitForFunction(() => document.title === 'done', null, {timeout: 45_000});
        results = await page.evaluate(() => (window as any).__results as PageResult[]);
    } catch (e) {
        const body = await page.content().catch(() => '<no content>');
        runError = `${(e as Error).message}\n--- console ---\n${consoleLog.join('\n')}\n--- page ---\n${body}`;
    } finally {
        try { await ctx.close(); } catch {}
    }
}, 60_000);

afterAll(async () => {
    try { await browser?.close(); } catch {}
    listener?.stop(true);
}, 30_000);

describe("FileSystem contract — OpfsFs (headless Chrome)", () => {
    const expectedNames = [
        "write then read returns content",
        "open missing file returns ENOENT",
        "stat reports size + type",
        "mkdir + readdir lists entries",
        "rename moves file",
        "unlink removes file",
        "rmdir removes empty dir",
        "rmdir non-empty fails ENOTEMPTY",
        "truncate shrinks file",
        "persistence across respawn",
    ];
    for (const name of expectedNames) {
        it(name, () => {
            if (runError) throw new Error(runError);
            if (!results) throw new Error("no results");
            const r = results.find(x => x.name === name);
            if (!r) throw new Error(`no result for "${name}"`);
            if (!r.passed) throw new Error(r.message ?? `case "${name}" failed`);
            expect(r.passed).toBe(true);
        });
    }
});
