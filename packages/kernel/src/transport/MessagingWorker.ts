export interface MessagingWorker {
    postMessage(message: unknown, transfer?: ReadonlyArray<unknown>): void;
    addMessageListener(listener: (message: any) => void): void;
    addErrorListener(listener: (err: Error) => void): void;
    terminate(): void;
}

export type MessagingWorkerFactory = (url: string) => MessagingWorker;
