import type { UiRequest } from './contracts.ts';

export function permittedUiRequest(
  message: unknown,
  sender: { id?: string; url?: string; frameId?: number },
  extensionId: string,
  popupUrl: string,
  optionsUrl: string,
): message is UiRequest {
  if (
    sender.id !== extensionId ||
    (sender.frameId !== undefined && sender.frameId !== 0) ||
    ![popupUrl, optionsUrl].includes(sender.url ?? '') ||
    !message ||
    typeof message !== 'object' ||
    Array.isArray(message)
  ) {
    return false;
  }
  const value = message as Record<string, unknown>;
  if (typeof value.type !== 'string') return false;
  if (['status', 'check', 'retry'].includes(value.type)) return Object.keys(value).length === 1;
  if (sender.url !== optionsUrl) return false;
  if (value.type === 'settings:get') return Object.keys(value).length === 1;
  return value.type === 'settings:save' && Object.keys(value).length === 2 && 'settings' in value;
}
