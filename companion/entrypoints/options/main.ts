import { mountOptions } from '../../components/app.ts';
import type { MountedUi } from '../../components/app.ts';
import type { UiReply, UiRequest } from '../../utils/contracts.ts';

export async function main(): Promise<MountedUi> {
  const { browser } = await import('wxt/browser');
  const root = document.getElementById('app');
  if (!root) throw new Error('The options root is missing.');
  const request = (message: UiRequest): Promise<UiReply> => browser.runtime.sendMessage(message);
  const ui = mountOptions(root, request);
  const refresh = () => {
    void ui.refresh();
  };
  const changed = (message: unknown) => {
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'status:changed'
    )
      refresh();
  };
  browser.runtime.onMessage.addListener(changed);
  window.addEventListener('focus', refresh);
  const destroy = () => {
    browser.runtime.onMessage.removeListener(changed);
    window.removeEventListener('focus', refresh);
    window.removeEventListener('pagehide', destroy);
    ui.destroy();
  };
  window.addEventListener('pagehide', destroy, { once: true });
  return { ...ui, destroy };
}
