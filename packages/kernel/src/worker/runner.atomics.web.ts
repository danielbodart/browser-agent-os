/// <reference lib="webworker" />
import {bootAtomicsRunner} from "./atomics.ts";

bootAtomicsRunner({
    onMessage(handler) {
        self.addEventListener('message', e => handler((e as MessageEvent).data));
    },
    postMessage(msg) {
        self.postMessage(msg);
    },
});
