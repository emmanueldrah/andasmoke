import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const workspace = readFileSync(new URL('../src/components/admin/screens/AdminPOSWorkspace.tsx', import.meta.url), 'utf8');

function themeTokens(selector) {
  const block = css.match(selector)[1];
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]{6})\s*;/gi)].map((match) => [match[1], match[2]]));
}

function luminance(hex) {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(first, second) {
  const levels = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (levels[0] + 0.05) / (levels[1] + 0.05);
}

for (const [theme, selector] of [['light', /:root\s*\{([\s\S]*?)\n\s*\}/], ['dark', /html\.dark\s*\{([\s\S]*?)\n\s*\}/]]) {
  test(`${theme} glass backing and control tokens keep normal text at 4.5:1 contrast`, () => {
    const tokens = themeTokens(selector);
    const pairs = [
      ['text-primary', 'surface-solid'],
      ['text-muted', 'surface-solid'],
      ['text-subtle', 'surface-solid'],
      ['text-primary', 'control-solid'],
      ['text-subtle', 'control-solid'],
      ['accent', 'surface-solid'],
      ['accent-ink', 'accent'],
      ['accent-ink', 'accent-strong'],
      ['danger-ink', 'danger'],
      ['disabled-ink', 'disabled-bg'],
    ];
    for (const [ink, backing] of pairs) {
      assert(tokens[ink] && tokens[backing], `Missing ${ink} or ${backing}`);
      const ratio = contrast(tokens[ink], tokens[backing]);
      assert(ratio >= 4.5, `${theme}: ${ink} on ${backing} is only ${ratio.toFixed(2)}:1`);
    }
  });
}

test('payment stays in a separate nonshrinking footer, after scrollable settlement', () => {
  const settlement = workspace.indexOf('className="pos-ticket__settlement');
  const tickets = workspace.indexOf('Held tickets', settlement);
  const footer = workspace.indexOf('className="pos-ticket__footer');
  const pay = workspace.indexOf('className="pos-pay w-full"');
  assert(settlement >= 0 && tickets > settlement && footer > tickets && pay > footer);
  assert.match(css, /\.pos-workspace \.pos-ticket__settlement\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/);
  assert.match(css, /\.pos-workspace \.pos-ticket__footer\s*\{[^}]*flex:\s*0 0 auto;/);
});

test('the outer frame does not trap fixed dialogs or sticky chrome', () => {
  const frame = css.match(/\.admin-shell__frame\s*\{([\s\S]*?)\n\s*\}/)[1];
  assert.match(frame, /overflow:\s*clip;/);
  assert.doesNotMatch(frame, /backdrop-filter\s*:/);
});

test('disabled controls retain readable ink instead of fading the entire control', () => {
  const disabled = css.match(/#root :is\(button, input, select, textarea\):disabled\s*\{([\s\S]*?)\n\}/)[1];
  assert.match(disabled, /opacity:\s*1;/);
  assert.match(disabled, /color:\s*var\(--disabled-ink\)/);
  assert.match(disabled, /background:\s*var\(--disabled-bg\)/);
});
