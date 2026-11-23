export interface CaptureEnvelope {
  schemaVersion: 1;
  id: string;
  source: 'companion';
  url: string;
  title: string;
  capturedAt: string;
  browser: { name: string; version: string; instance?: string };
  tab: { id: number; windowId: number; documentId?: string };
  images: Array<{
    id: string;
    mimeType: 'image/png';
    dataBase64: string;
    width: number;
    height: number;
  }>;
  text: string;
  context: {
    condition?: 'installed';
    pageState: 'unknown';
    sensitivity: 'unknown';
  };
  limitations: string[];
}

export interface ConnectionSettings {
  endpoint: string;
  token: string;
}

export type ConnectionState =
  'unconfigured' | 'checking' | 'online' | 'offline' | 'unauthorized' | 'error';

export interface QueueSummary {
  pending: number;
  blocked: number;
  bytes: number;
  oldestAt?: string;
  nextRetryAt?: string;
  retryPaused?: boolean;
  lastError?: string;
}

export interface CompanionStatus {
  connection: ConnectionState;
  connectionMessage: string;
  checkedAt?: string;
  endpoint: string;
  configured: boolean;
  queue: QueueSummary;
  shortcut: string;
  browser: 'chrome' | 'firefox';
  capture: { state: 'idle' | 'capturing' | 'saved' | 'error'; message: string; at?: string };
  lastDelivery?: { id: string; at: string };
}

export type UiRequest =
  | { type: 'status' }
  | { type: 'retry' }
  | { type: 'check' }
  | { type: 'settings:get' }
  | { type: 'settings:save'; settings: ConnectionSettings };

export interface UiReply {
  ok: boolean;
  status?: CompanionStatus;
  settings?: ConnectionSettings;
  error?: string;
}
