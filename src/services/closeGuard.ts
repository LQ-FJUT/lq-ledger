export interface CloseRequestEvent {
  preventDefault(): void;
}

export interface CloseGuardOptions {
  isBlocked(): boolean;
  prepareConfirmation?(): Promise<void>;
  confirmDiscard(): Promise<boolean>;
  destroy(): Promise<void>;
  onError?(error: unknown): void;
}

export function createCloseRequestedHandler(options: CloseGuardOptions): (event: CloseRequestEvent) => void {
  let pending: Promise<void> | null = null;

  return (event) => {
    event.preventDefault();
    if (pending) return;

    pending = (async () => {
      try {
        if (options.isBlocked()) {
          if (options.prepareConfirmation) await options.prepareConfirmation();
          if (!await options.confirmDiscard()) return;
        }
        await options.destroy();
      } catch (error) {
        options.onError?.(error);
      } finally {
        pending = null;
      }
    })();
  };
}
