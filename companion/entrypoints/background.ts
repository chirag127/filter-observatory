import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { startBackground } from '../utils/background.ts';

export default defineBackground({
  main() {
    startBackground(browser, import.meta.env.FIREFOX ? 'firefox' : 'chrome');
  },
});
