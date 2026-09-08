import { flushPromises } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createCloseRequestedHandler } from '../src/services/closeGuard';

function event() {
  return { preventDefault: vi.fn() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe('关闭确认保护', () => {
  it('没有未保存内容时也显式拦截并销毁窗口', async () => {
    const confirmDiscard = vi.fn();
    const destroy = vi.fn(() => Promise.resolve());
    const request = createCloseRequestedHandler({
      isBlocked: () => false,
      confirmDiscard,
      destroy,
    });
    const closeEvent = event();

    request(closeEvent);
    await Promise.resolve();

    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('连续关闭请求只弹一次，确认后强制销毁窗口', async () => {
    const confirmation = deferred<boolean>();
    const confirmDiscard = vi.fn(() => confirmation.promise);
    const destroy = vi.fn(() => Promise.resolve());
    const request = createCloseRequestedHandler({ isBlocked: () => true, confirmDiscard, destroy });
    const firstEvent = event();
    const secondEvent = event();

    request(firstEvent);
    request(secondEvent);
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(secondEvent.preventDefault).toHaveBeenCalledOnce();
    expect(confirmDiscard).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();

    confirmation.resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(destroy).toHaveBeenCalledOnce();
  });

  it('取消后允许下一次重新确认', async () => {
    const confirmDiscard = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const destroy = vi.fn(() => Promise.resolve());
    const request = createCloseRequestedHandler({ isBlocked: () => true, confirmDiscard, destroy });

    request(event());
    await Promise.resolve();
    await Promise.resolve();
    request(event());
    await Promise.resolve();
    await Promise.resolve();

    expect(confirmDiscard).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('关闭准备失败或销毁失败后解除单飞锁并报告错误', async () => {
    const confirmDiscard = vi.fn().mockResolvedValue(true);
    const prepareConfirmation = vi.fn()
      .mockRejectedValueOnce(new Error('恢复窗口失败'))
      .mockResolvedValue(undefined);
    const destroy = vi.fn()
      .mockRejectedValueOnce(new Error('销毁窗口失败'))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const request = createCloseRequestedHandler({ isBlocked: () => true, prepareConfirmation, confirmDiscard, destroy, onError });

    request(event());
    await flushPromises();
    request(event());
    await flushPromises();
    request(event());
    await flushPromises();

    expect(prepareConfirmation).toHaveBeenCalledTimes(3);
    expect(confirmDiscard).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
