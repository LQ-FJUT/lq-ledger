import { reactive } from 'vue';

export type ConfirmChannel = 'default' | 'close';
export type ConfirmOptions = { title?: string; confirmLabel?: string; danger?: boolean };

export const confirmState = reactive({ open: false, title: '请确认', message: '', confirmLabel: '确认', danger: false, channel: 'default' as ConfirmChannel });
let pending: { channel: ConfirmChannel; promise: Promise<boolean>; resolve: (value: boolean) => void } | null = null;

function closePending(value: boolean): void {
  const current = pending;
  pending = null;
  confirmState.open = false;
  current?.resolve(value);
}

function requestConfirmation(message: string, options: ConfirmOptions, channel: ConfirmChannel): Promise<boolean> {
  if (pending) {
    if (channel === 'default' && pending.channel === 'close') return Promise.resolve(false);
    closePending(false);
  }
  confirmState.title = options.title ?? '请确认';
  confirmState.message = message;
  confirmState.confirmLabel = options.confirmLabel ?? '确认';
  confirmState.danger = options.danger ?? false;
  confirmState.channel = channel;
  confirmState.open = true;
  let resolvePromise!: (value: boolean) => void;
  const promise = new Promise<boolean>((resolve) => { resolvePromise = resolve; });
  pending = { channel, promise, resolve: resolvePromise };
  return promise;
}

export function confirmAction(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  return requestConfirmation(message, options, 'default');
}

export function confirmCloseAction(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  if (pending?.channel === 'close') return pending.promise;
  return requestConfirmation(message, options, 'close');
}

export function resolveConfirm(value: boolean): void {
  closePending(value);
}
