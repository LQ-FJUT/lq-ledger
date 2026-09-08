import { afterEach, describe, expect, it } from 'vitest';
import { confirmAction, confirmCloseAction, confirmState, resolveConfirm } from '../src/services/confirm';

afterEach(() => resolveConfirm(false));

describe('确认框通道', () => {
  it('关闭确认打开时不会被普通确认替换', async () => {
    const closePromise = confirmCloseAction('关闭？', { title: '关闭应用' });
    const regularResult = await confirmAction('删除？');

    expect(regularResult).toBe(false);
    expect(confirmState.open).toBe(true);
    expect(confirmState.channel).toBe('close');

    resolveConfirm(true);
    await expect(closePromise).resolves.toBe(true);
  });

  it('普通确认存在时关闭确认会先取消普通确认', async () => {
    const regularPromise = confirmAction('删除？');
    const closePromise = confirmCloseAction('关闭？');

    await expect(regularPromise).resolves.toBe(false);
    expect(confirmState.channel).toBe('close');

    resolveConfirm(false);
    await expect(closePromise).resolves.toBe(false);
  });
});
