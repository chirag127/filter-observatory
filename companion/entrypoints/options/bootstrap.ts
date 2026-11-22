import { main } from './main.ts';

function start() {
  void main().catch(() => {
    const root = document.getElementById('app');
    if (root) {
      root.textContent = 'The companion could not start. Reload this settings page to try again.';
      root.setAttribute('role', 'alert');
    }
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
