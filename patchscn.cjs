const fs=require('fs');
const f='C:/Users/SAD/Desktop/POS/src/components/admin/screens/AdminPOSWorkspace.tsx';
let s=fs.readFileSync(f,'utf8');

// 1. Header comment: mention Tab as well as Enter.
s=s.replace(
`   * This watches for that pattern — several characters in quick succession,
   * finished by Enter — and once it is confident the keystrokes came from a
   * scanner, pulls focus back to the scan box and re-runs the buffered code
   * through the normal path. Characters are only taken back from a field when
   * they are the tail of a burst that ended in Enter, so ordinary typing and
   * Enter-to-confirm are untouched.
   */`,
`   * This watches for that pattern — several characters in quick succession,
   * finished by Enter or Tab — and once it is confident the keystrokes came from
   * a scanner, pulls focus back to the scan box and re-runs the buffered code
   * through the normal path.
   *
   * Fields that are *meant* to receive typed codes opt out via
   * \`data-barcode-input\`, a password type, or a name/id containing "barcode"
   * or "pin"; see {@link isScannerExempt}. The thresholds live in Settings so a
   * slow scanner can be tuned without a rebuild.
   */`);

// 2. Exemption check at the top of the handler.
s=s.replace(
`      const isTyping = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      // ── Scanner detection ──`,
`      const isTyping = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      // Fields that exist to *receive* a typed code are left alone entirely.
      if (isScannerExempt(target)) {
        scannerBurst.current = { chars: 0, startedAt: 0, lastAt: 0, text: '' };
        return;
      }

      // ── Scanner detection ──`);

// 3. Thresholds come from settings.
s=s.replace('now - burst.lastAt > SCANNER_PAUSE_RESET_MS','now - burst.lastAt > scanner.pauseResetMs');
s=s.replace(
`        const looksLikeScanner = burst.chars >= SCANNER_MIN_CHARS
          && elapsed <= SCANNER_BURST_WINDOW_MS
          && avgGap <= SCANNER_MAX_AVG_GAP_MS;`,
`        const looksLikeScanner = burst.chars >= scanner.minChars
          && elapsed <= scanner.maxBurstMs
          && avgGap <= scanner.maxAverageGapMs
          && burst.text.length <= scanner.maxCodeLength;`);

// 4. Enter or Tab terminates a scan.
s=s.replace(
`      if (event.key === 'Enter') {
        const burst = scannerBurst.current;`,
`      // Enter and Tab both terminate a scan: most scanners send Enter, but some
      // are configured for Tab, and a till that silently ignores those would
      // look broken for no visible reason.
      if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
        const burst = scannerBurst.current;`);

// 5. Effect deps + local scanner const.
s=s.replace(
`  }, [cart.length, completeSale, holdSale, scannerValue]);`,
`  }, [cart.length, completeSale, holdSale, scannerValue, scanner]);`);

fs.writeFileSync(f,s);
console.log('patched');
