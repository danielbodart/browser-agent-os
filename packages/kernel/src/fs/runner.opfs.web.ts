/// <reference lib="webworker" />
import {bootOpfsBackend} from "./opfsBackend.ts";

void bootOpfsBackend({
    onMessage(handler) {
        self.addEventListener('message', e => handler((e as MessageEvent).data));
    },
    postMessage(msg) {
        self.postMessage(msg);
    },
});
