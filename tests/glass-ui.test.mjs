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
      ['text-muted', 'surface-main-solid'],
      ['text-subtle', 'surface-alt-solid'],
      ['text-subtle', 'surface-soft-solid'],
      ['accent', 'surface-solid'],
      ['highlight', 'surface-solid'],
      ['jade', 'surface-solid'],
      ['violet', 'surface-solid'],
      ['danger', 'surface-solid'],
      ['accent-ink', 'accent'],
      ['accent-ink', 'accent-strong'],
      ['danger-ink', 'danger'],
      ['disabled-ink', 'disabled-solid'],
    ];
    for (const [ink, backing] of pairs) {
      assert(tokens[ink] && tokens[backing], `Missing ${ink} or ${backing}`);
      const ratio = contrast(tokens[ink], tokens[backing]);
      assert(ratio >= 4.5, `${theme}: ${ink} on ${backing} is only ${ratio.toFixed(2)}:1`);
    }
  });
}

function composite(foreground, backing) {
  const rgb = [1, 3, 5].map(offset => parseInt(backing.slice(offset, offset + 2), 16));
  return '#' + foreground.slice(0, 3).map((channel, index) => Math.round(channel * foreground[3] + rgb[index] * (1 - foreground[3])).toString(16).padStart(2, '0')).join('');
}

for (const [theme, selector] of [['light', /:root\s*\{([\s\S]*?)\n\s*\}/], ['dark', /html\.dark\s*\{([\s\S]*?)\n\s*\}/]]) {
  test(`${theme} translucent panes and semantic tints preserve text contrast`, () => {
    const tokens = themeTokens(selector);
    const block = css.match(selector)[1];
    const page = block.match(/--page-background:([\s\S]*?);/)[1];
    const canvases = [...page.matchAll(/#[\da-f]{6}/gi)].map(match => match[0]);
    const glows = [...page.matchAll(/rgba\(([^)]+)\)/g)].map(match => match[1].split(',').map(Number));
    const markAlpha = Number(block.match(/--mark-opacity:\s*([\d.]+)/)[1]);
    const pageCanvases = [...canvases, ...canvases.map(canvas => glows.reduce((backing, glow) => composite(glow, backing), canvas))];
    const stressCanvases = [...pageCanvases, ...pageCanvases.flatMap(canvas => [composite([0, 0, 0, markAlpha], canvas), composite([255, 255, 255, markAlpha], canvas)])];
    for (const key of ['bg-card', 'bg-card-alt', 'bg-soft', 'control-bg', 'sheet-surface', 'disabled-bg']) {
      const tint = block.match(new RegExp(`--${key}:\\s*rgba\\(([^)]+)\\)`))[1].split(',').map(Number);
      const inks = key === 'disabled-bg' ? ['disabled-ink'] : ['text-primary', 'text-muted', 'text-subtle'];
      for (const canvas of stressCanvases) {
        const backing = composite(tint, canvas);
        for (const ink of inks) {
          const ratio = contrast(tokens[ink], backing);
          assert(ratio >= 4.5, `${theme}: ${ink} on translucent ${key} is ${ratio.toFixed(2)}:1`);
        }
        if (['bg-card', 'bg-card-alt', 'bg-soft', 'sheet-surface'].includes(key)) {
          for (const [ink, alpha] of [['jade', 0.1], ['highlight', 0.1], ['violet', 0.1], ['danger', 0.12]]) {
            const tint = [1, 3, 5].map(offset => parseInt(tokens[ink].slice(offset, offset + 2), 16));
            const ratio = contrast(tokens[ink], composite([...tint, alpha], backing));
            assert(ratio >= 4.5, `${theme}: ${ink} tinted chip/hover on ${key} is ${ratio.toFixed(2)}:1`);
          }
        }
      }
    }
    const fillTokens = ['gold-light', 'gold-metal', 'gold-deep', 'accent', 'danger'];
    for (const fill of fillTokens) {
      const ink = fill.startsWith('gold-') ? 'gold-ink' : `${fill}-ink`;
      const tint = [1, 3, 5].map(offset => parseInt(tokens[fill].slice(offset, offset + 2), 16));
      for (const canvas of stressCanvases) {
        const ratio = contrast(tokens[ink], composite([...tint, 0.92], canvas));
        assert(ratio >= 4.5, `${theme}: ${ink} on translucent ${fill} is ${ratio.toFixed(2)}:1`);
      }
    }
  });
}

test('page, card, nested panel, field and dialog backings are translucent in both themes', () => {
  for (const selector of [/:root\s*\{([\s\S]*?)\n\s*\}/, /html\.dark\s*\{([\s\S]*?)\n\s*\}/]) {
    const block = css.match(selector)[1];
    for (const token of ['bg-main', 'bg-card', 'bg-card-alt', 'bg-soft', 'control-bg', 'sheet-surface', 'disabled-bg', 'table-action-bg']) {
      const value = block.match(new RegExp(`--${token}:\\s*rgba\\(([^)]+)\\)`));
      assert(value, `${token} must keep a translucent normal-mode backing`);
      const alpha = Number(value[1].split(',').at(-1).trim());
      assert(alpha > 0 && alpha < 1, `${token} alpha must be between 0 and 1`);
    }
  }
});

test('watermark remains large, sharp and behind the interface in both themes', () => {
  for (const selector of [/:root\s*\{([\s\S]*?)\n\s*\}/, /html\.dark\s*\{([\s\S]*?)\n\s*\}/]) {
    const block = css.match(selector)[1];
    assert(Number(block.match(/--mark-opacity:\s*([\d.]+)/)[1]) >= 0.12);
    assert(Number(block.match(/--glass-blur:\s*(\d+)px/)[1]) <= 3);
  }
  assert.match(css, /--mark-blur:\s*0px/);
  const mark = css.match(/body::before\s*\{([\s\S]*?)\n\s*\}/)[1];
  assert.match(mark, /background-size:\s*min\(780px, 82vw, 84dvh\)/);
  assert.match(mark, /pointer-events:\s*none/);
  assert.match(mark, /z-index:\s*0/);
  assert.doesNotMatch(css, /body::after\s*\{/);
});

test('clear glass does not regress to nearly opaque paint on panels or controls', () => {
  const caps = { 'bg-main': 0.03, 'bg-card': 0.15, 'bg-card-alt': 0.1, 'bg-soft': 0.06, 'control-bg': 0.15, 'sheet-surface': 0.25, 'disabled-bg': 0.2, 'table-action-bg': 0.2 };
  for (const selector of [/:root\s*\{([\s\S]*?)\n\s*\}/, /html\.dark\s*\{([\s\S]*?)\n\s*\}/]) {
    const block = css.match(selector)[1];
    for (const [token, cap] of Object.entries(caps)) {
      const declaration = block.split(`--${token}:`)[1].split(';')[0];
      const alpha = Number(declaration.slice(declaration.lastIndexOf(',') + 1).replace(')', '').trim());
      assert(alpha > 0 && alpha <= cap, `${token}: ${alpha} exceeds clear-glass cap ${cap}`);
    }
  }
  assert.match(css, /--glass-cut:\s*linear-gradient\(118deg/);
  assert.match(css, /--glass-control-background:\s*var\(--glass-cut\), var\(--control-bg\)/);
  assert.match(css, /--glass-selected-background:[^;]*var\(--glass-control-background\)/);
});

for (const [theme, selector] of [['light', /:root\s*\{([\s\S]*?)\n\s*\}/], ['dark', /html\.dark\s*\{([\s\S]*?)\n\s*\}/]]) {
  test(`${theme} clear gold actions keep opaque ink readable across reflection stops`, () => {
    const tokens = themeTokens(selector);
    const block = css.match(selector)[1];
    const rgba = key => block.split(`--${key}:`)[1].split(';')[0].match(/rgba\(([^)]+)\)/)[1].split(',').map(Number);
    const tint = hex => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
    const page = block.match(/--page-background:([\s\S]*?);/)[1];
    const canvases = [...page.matchAll(/#[\da-f]{6}/gi)].map(match => match[0]);
    const glows = [...page.matchAll(/rgba\(([^)]+)\)/g)].map(match => match[1].split(',').map(Number));
    for (const canvas of [...canvases, ...canvases.map(c => glows.reduce((bg, glow) => composite(glow, bg), c))]) {
      for (const [gold, alpha] of [['gold-metal', 0.18], ['gold-light', 0.08], ['gold-deep', 0.16]]) {
        const button = composite([...tint(tokens[gold]), alpha], composite(rgba('control-bg'), canvas));
        for (const reflection of [[0, 0, 0, 0], rgba('glass-reflection'), rgba('glass-sheen-soft')]) {
          const ratio = contrast(tokens['glass-action-ink'], composite(reflection, button));
          assert(ratio >= 4.5, `${theme} gold glass action contrast: ${ratio.toFixed(2)}:1`);
        }
      }
    }
  });
}

test('notifications and error surfaces use shared themed glass without fixed fills', () => {
  for (const file of ['../src/context/ToastContext.tsx', '../src/context/AlertContext.tsx', '../src/components/common/ErrorBoundary.tsx']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /glass-notice/);
    assert.doesNotMatch(source, /bg-\[rgba\(30,25,21|bg-blue-50|bg-stone-100|text-\[#FAF7F2\]/);
  }
  assert.match(css, /--glass-control-background:\s*var\(--control-solid\)/);
  assert.match(css, /--glass-cut:\s*linear-gradient\(transparent, transparent\)/);
});

test('glass fields retain focus rings and color-valued Tailwind sheet aliases', () => {
  const sheet = css.match(/\.form-sheet\s*\{([\s\S]*?)\n\s*\}/)[1];
  for (const alias of ['sheet-field', 'sheet-field-focus', 'sheet-button']) {
    assert.match(sheet, new RegExp(`--${alias}:\\s*var\\(--control-bg\\)`));
  }
  const screenHooks = css.slice(css.indexOf('/* Surface hooks'));
  assert.match(screenHooks, /\):focus:not\(:disabled,[^}]*outline:\s*2px solid var\(--accent\);[^}]*box-shadow:[^}]*var\(--accent-soft\)/);
  const accounts = readFileSync(new URL('../src/components/admin/screens/AdminAccountsManagementScreen.tsx', import.meta.url), 'utf8');
  const role = accounts.slice(accounts.indexOf('id="profile-role"'), accounts.indexOf('id="profile-role"') + 300);
  assert.match(role, /readOnly/);
  assert.doesNotMatch(role, /opacity-60/);
  assert.match(css, /\.pos-pay__hint\s*\{[^}]*background:\s*var\(--glass-inset-background\)/);
});

test('unlayered glass controls preserve hover and pressed elevation without selector inflation', () => {
  const hooks = css.slice(css.indexOf('/* Surface hooks'));
  assert.match(hooks, /:where\(input:not\(\[type="checkbox"\]\)[^\n]*\),/);
  const primary = hooks.indexOf(':is(.lux-btn--primary, .pos-pay):not');
  const hover = hooks.indexOf('.pos-pay:hover:not(:disabled, [data-print-preview], [data-print-preview] *)');
  const pressed = hooks.indexOf(':is(.lux-btn, .lux-btn--primary, .pos-qty, .pos-pay):active:not(:disabled, [data-print-preview], [data-print-preview] *)');
  assert(primary >= 0 && hover > primary && pressed > hover);
  const controls = hooks.slice(0, primary);
  assert.doesNotMatch(controls, /\bbutton\[class~/, 'button types must not inflate hover specificity above active');
  assert.equal([...controls.matchAll(/:where\(button\)\[class~/g)].length, 6);
  assert.match(hooks.slice(hover, hooks.indexOf('}', hover)), /box-shadow:\s*var\(--clay-lift\), var\(--shadow-card\)/);
  assert.match(hooks.slice(pressed, hooks.indexOf('}', pressed)), /box-shadow:\s*var\(--clay-well\)/);
});

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

test('standard glass blur survives the production CSS optimizer', () => {
  // Lightning CSS merges duplicate prefixed declarations and retains the last.
  // Electron requires the standard property, so it must follow the legacy one.
  const filters = [...css.matchAll(/(?<!-)backdrop-filter:\s*var\(--glass(?:-chrome)?-filter\);/g)];
  assert(filters.length >= 7);
  for (const match of filters) {
    const preceding = css.slice(Math.max(0, match.index - 90), match.index);
    assert.match(preceding, /-webkit-backdrop-filter:\s*var\(--glass(?:-chrome)?-filter\);\s*$/);
  }
});

test('disabled controls retain readable ink instead of fading the entire control', () => {
  const disabled = css.match(/#root :is\(button, input, select, textarea\):disabled\s*\{([\s\S]*?)\n\}/)[1];
  assert.match(disabled, /opacity:\s*1;/);
  assert.match(disabled, /color:\s*var\(--disabled-ink\)/);
  assert.match(disabled, /background:\s*var\(--disabled-bg\)/);
});

test('login uses the shared theme instead of an inline blue palette', () => {
  const login = readFileSync(new URL('../src/components/admin/AdminLoginView.tsx', import.meta.url), 'utf8');
  assert.match(login, /className="admin-login /);
  assert.doesNotMatch(login, /background: isDark/);
  assert.doesNotMatch(login, /opacity-\[0\.0[56]\]/);
  assert.match(css, /\.admin-login:not\([^}]*background:\s*transparent/);
  assert.doesNotMatch(login, /to-\[var\(--accent-strong\)\][^"\n]*text-white/);
  assert.match(login, /grid grid-cols-1 lg:grid-cols-\[minmax\(0,0\.9fr\)_minmax\(0,1\.1fr\)\]/);
  assert.match(login, /grid grid-cols-1 gap-2 sm:grid-cols-2/);
  assert.match(login, /flex min-w-0 flex-col justify-center/);
});

test('product and stock dialogs share the theme-aware glass sheet', () => {
  const product = readFileSync(new URL('../src/components/admin/POSProductModal.tsx', import.meta.url), 'utf8');
  const inventory = readFileSync(new URL('../src/components/admin/screens/AdminPOSManagementScreens.tsx', import.meta.url), 'utf8');
  const barcode = readFileSync(new URL('../src/components/admin/components/BarcodeLabelsModal.tsx', import.meta.url), 'utf8');
  for (const source of [product, inventory, barcode]) {
    assert.match(source, /glass-dialog-backdrop fixed inset-0/);
    assert.match(source, /className="form-sheet /);
  }
  assert.match(barcode, /data-print-preview/);
});

test('application overview and shared stats use glass surfaces', () => {
  const about = readFileSync(new URL('../src/components/admin/screens/AdminAboutScreen.tsx', import.meta.url), 'utf8');
  const primitives = readFileSync(new URL('../src/components/admin/components/AdminPrimitives.tsx', import.meta.url), 'utf8');
  assert.match(about, /<section className="lux-card flex flex-col gap-4 p-5/);
  assert.match(primitives, /className="glass-panel grid grid-cols-2/);
  assert.match(primitives, /className="glass-inset flex flex-col/);
});
