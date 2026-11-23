export interface CaptureTarget {
  id: number;
  windowId: number;
}

export type AttributionEvent =
  | { kind: 'activated'; tabId: number; windowId: number }
  | { kind: 'focused'; windowId: number }
  | { kind: 'updated'; tabId: number; navigated: boolean }
  | { kind: 'removed' | 'detached'; tabId: number }
  | { kind: 'replaced'; tabId: number }
  | { kind: 'window-removed'; windowId: number };

export class AttributionGuard {
  private target?: CaptureTarget;
  private pending: AttributionEvent[] = [];
  private changed = false;

  setTarget(target: CaptureTarget): void {
    if (this.target && (this.target.id !== target.id || this.target.windowId !== target.windowId)) {
      this.changed = true;
    }
    this.target = { ...target };
    for (const event of this.pending) this.observe(event);
    this.pending = [];
  }

  observe(event: AttributionEvent): void {
    if (!this.target) {
      // An optional onCommand tab may require an async query. Do not lose that interval.
      if (event.kind === 'activated' || event.kind === 'focused') this.changed = true;
      if (this.pending.length >= 128) this.changed = true;
      else this.pending.push(event);
      return;
    }
    const target = this.target;
    if (event.kind === 'activated') {
      this.changed ||= event.windowId === target.windowId && event.tabId !== target.id;
    } else if (event.kind === 'focused') {
      this.changed ||= event.windowId !== target.windowId;
    } else if (event.kind === 'window-removed') {
      this.changed ||= event.windowId === target.windowId;
    } else if (event.kind === 'updated') {
      this.changed ||= event.tabId === target.id && event.navigated;
    } else {
      this.changed ||= event.tabId === target.id;
    }
  }

  assertUnchanged(): void {
    if (this.changed)
      throw new Error('Capture target changed. Keep the page active and capture again.');
    if (!this.target) throw new Error('Capture target is not resolved.');
  }
}
