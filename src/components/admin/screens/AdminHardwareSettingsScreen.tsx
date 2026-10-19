import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Barcode, Check, Printer, RotateCcw, Settings2 } from 'lucide-react';
import { useStore } from '../../../context/StoreContext';
import { useAlert } from '../../../context/AlertContext';
import { api } from '../../../lib/api';
import {
  DEFAULT_HARDWARE_SETTINGS,
  normalizeHardwareSettings,
  type HardwareSettings,
} from '../../../lib/hardware';
import { nextInternalBarcode, planLabel, renderLabelSvg } from '../../../lib/code128';
import type { Product } from '../../../types';

/**
 * Hardware settings: scanner timing and label size.
 *
 * The scanner thresholds are here because they are the one setting that depends
 * on the till's actual equipment. A cheap scanner on a busy till can be slower
 * than the default, and a manager needs to be able to loosen the threshold rather
 * than conclude the hardware is broken.
 */
export function AdminHardwareSettingsScreen(): React.ReactElement {
  const store = useStore();
  const { showAlert } = useAlert();
  const isManager = store.adminSession.adminRole === 'Super Admin' || store.adminSession.adminRole === 'Store Manager';

  const [draft, setDraft] = useState<HardwareSettings>(store.hardwareSettings ?? DEFAULT_HARDWARE_SETTINGS);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(store.hardwareSettings ?? DEFAULT_HARDWARE_SETTINGS);
  }, [store.hardwareSettings]);

  const save = async () => {
    setSaving(true);
    try {
      await store.saveHardwareSettings(draft);
      showAlert('Hardware settings saved.', 'success');
    } catch (error: any) {
      showAlert(error?.data?.error || error?.message || 'Could not save the settings.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const numberField = (
    label: string,
    value: number,
    onChange: (value: number) => void,
    hint?: string,
    min = 1,
  ) => (
    <label className="block">
      <span className="lux-label">{label}</span>
      <input
        type="number"
        className="lux-input"
        min={min}
        value={Number.isFinite(value) ? value : ''}
        disabled={!isManager}
        onChange={event => onChange(Number(event.target.value))}
      />
      {hint && <span className="mt-1 block text-[11px] text-[var(--text-subtle)]">{hint}</span>}
    </label>
  );

  return (
    <div className="space-y-4">
      <header className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
          <Settings2 className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-base font-bold text-[var(--text-primary)]">Hardware</h2>
          <p className="mt-1 text-sm leading-5 text-[var(--text-muted)]">Tune scanner behavior and configure shelf-label dimensions.</p>
        </div>
      </header>

      {!isManager && (
        <p className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-soft)] p-3 text-xs text-[var(--text-muted)]">
          Only the owner or a store manager can change these. The values below are what this till is using.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── Scanner timing ─────────────────────────────────────────────── */}
        <section className="lux-card space-y-4 p-4 md:p-5">
          <div className="flex items-center gap-2">
            <Barcode className="h-4 w-4 text-[var(--accent)]" />
            <h2 className="text-base font-bold text-[var(--text-primary)]">Scanner timing</h2>
          </div>
          <p className="text-xs text-[var(--text-muted)]">
            A scanner sends a barcode far faster than a person can type. The counter measures the average
            gap between characters and treats a burst as a scan when it is below the limit below.
          </p>

          <div className="grid grid-cols-2 gap-3">
            {numberField(
              'Max average gap (ms)',
              draft.scanner.maxAverageGapMs,
              value => setDraft(current => ({ ...current, scanner: { ...current.scanner, maxAverageGapMs: value } })),
              'Raise this if a working scanner is not being recognised.',
              5,
            )}
            {numberField(
              'Minimum characters',
              draft.scanner.minChars,
              value => setDraft(current => ({ ...current, scanner: { ...current.scanner, minChars: value } })),
              'Below this, a burst is treated as typing.',
              3,
            )}
            {numberField(
              'Longest burst (ms)',
              draft.scanner.maxBurstMs,
              value => setDraft(current => ({ ...current, scanner: { ...current.scanner, maxBurstMs: value } })),
              'Total time a whole scan may take.',
              200,
            )}
            {numberField(
              'Pause ends burst (ms)',
              draft.scanner.pauseResetMs,
              value => setDraft(current => ({ ...current, scanner: { ...current.scanner, pauseResetMs: value } })),
              'A longer gap starts a new burst.',
              50,
            )}
          </div>

          {isManager && (
            <div className="flex flex-wrap gap-2">
              <button onClick={() => void save()} disabled={saving} className="lux-btn lux-btn--primary lux-btn--sm">
                <Check className="h-4 w-4" />
                {saving ? 'Saving…' : 'Save timing'}
              </button>
              <button
                onClick={() => setDraft(current => ({ ...current, scanner: DEFAULT_HARDWARE_SETTINGS.scanner }))}
                className="lux-btn lux-btn--outline lux-btn--sm"
              >
                <RotateCcw className="h-4 w-4" />
                Defaults
              </button>
            </div>
          )}
        </section>

        {/* ── Label size ─────────────────────────────────────────────────── */}
        <section className="lux-card space-y-4 p-4 md:p-5">
          <div className="flex items-center gap-2">
            <Printer className="h-4 w-4 text-[var(--accent)]" />
            <h2 className="text-base font-bold text-[var(--text-primary)]">Label size</h2>
          </div>
          <p className="text-xs text-[var(--text-muted)]">
            Enter the size of the label stock you load. Labels print at true physical size so the bars
            stay sharp enough for a handheld to read.
          </p>

          <div className="grid grid-cols-2 gap-3">
            {numberField(
              'Width (mm)',
              draft.label.widthMm,
              value => setDraft(current => ({ ...current, label: { ...current.label, widthMm: value } })),
              undefined,
              20,
            )}
            {numberField(
              'Height (mm)',
              draft.label.heightMm,
              value => setDraft(current => ({ ...current, label: { ...current.label, heightMm: value } })),
              undefined,
              10,
            )}
          </div>

          <LabelPreview label={draft.label} />

          {isManager && (
            <button onClick={() => void save()} disabled={saving} className="lux-btn lux-btn--primary lux-btn--sm">
              <Check className="h-4 w-4" />
              {saving ? 'Saving…' : 'Save label size'}
            </button>
          )}
        </section>
      </div>

      {/* ── Test the scanner ─────────────────────────────────────────────── */}
      <ScannerTestBox thresholds={store.hardwareSettings.scanner} />
    </div>
  );
}

/** Shows what the chosen label size will produce, at true proportions. */
function LabelPreview({ label }: { label: HardwareSettings['label'] }): React.ReactElement {
  const cleaned = normalizeHardwareSettings({ label }).label;
  const layout = planLabel('ACS-000123', cleaned);
  return (
    <div className="rounded-lg border border-dashed border-[var(--border-color)] p-3">
      <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--text-muted)]">
        Preview · {cleaned.widthMm} × {cleaned.heightMm} mm
      </p>
      <div
        className="flex items-center justify-center overflow-hidden rounded bg-white p-2"
        style={{ height: Math.min(200, cleaned.heightMm * 3) }}
        // The SVG is sized in millimetres, so this is a true-size preview.
        dangerouslySetInnerHTML={{ __html: renderLabelSvg('ACS-000123', cleaned) }}
      />
      <p className="mt-2 text-[11px] text-[var(--text-subtle)]">
        Bar width {layout.moduleWidthMm.toFixed(3)} mm · bar height {layout.barHeightMm.toFixed(1)} mm ·{' '}
        quiet zone {layout.quietZoneMm.toFixed(1)} mm
        {layout.overflow && (
          <span className="ml-1 font-bold text-[var(--danger)]">— too small for this code, use a wider label</span>
        )}
      </p>
    </div>
  );
}

/**
 * Measures the keystrokes the till is actually seeing.
 *
 * The settings above are guesswork until someone points a real scanner at the
 * box, so this reads the same numbers the counter uses and reports the measured
 * average gap against the limit.
 */
function ScannerTestBox({ thresholds }: { thresholds: HardwareSettings['scanner'] }): React.ReactElement {
  const burst = useRef<{ chars: number; startedAt: number; lastAt: number }>({ chars: 0, startedAt: 0, lastAt: 0 });
  const [result, setResult] = useState<{ chars: number; avgGap: number; verdict: string; ok: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const measure = useCallback(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key.length === 1) {
        const now = event.timeStamp;
        if (burst.current.chars > 0 && now - burst.current.lastAt > thresholds.pauseResetMs) {
          burst.current = { chars: 1, startedAt: now, lastAt: now };
          return;
        }
        if (burst.current.chars === 0) burst.current = { chars: 1, startedAt: now, lastAt: now };
        else burst.current.chars++;
        burst.current.lastAt = now;
        return;
      }
      if (event.key !== 'Enter' && event.key !== 'Tab') return;

      const { chars, startedAt } = burst.current;
      burst.current = { chars: 0, startedAt: 0, lastAt: 0 };
      if (chars < 2) return;
      event.preventDefault();

      const elapsed = event.timeStamp - startedAt;
      const avgGap = elapsed / (chars - 1);
      const ok = chars >= thresholds.minChars && avgGap <= thresholds.maxAverageGapMs;
      setResult({
        chars,
        avgGap: Math.round(avgGap * 10) / 10,
        verdict: ok
          ? `Recognised as a scanner (limit ${thresholds.maxAverageGapMs} ms).`
          : `Below the limit of ${thresholds.maxAverageGapMs} ms, so the counter would treat this as typing.`,
        ok,
      });
    };
    window.addEventListener('keydown', onKeydown, true);
    return () => window.removeEventListener('keydown', onKeydown, true);
  }, [thresholds]);

  useEffect(measure, [measure]);

  return (
    <section className="lux-card space-y-3 p-5">
      <div className="flex items-center gap-2">
        <Settings2 className="h-4 w-4 text-[var(--accent)]" />
        <h2 className="text-base font-bold text-[var(--text-primary)]">Test this scanner</h2>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        Scan any barcode into this box. The measured speed is compared with the limit above, so you can
        set the threshold from what the hardware actually does rather than a guess.
      </p>

      <input
        ref={inputRef}
        // Opts out of the counter's global capture: this box exists to receive a
        // scanned code, not to be overridden by it.
        data-barcode-input="test-scanner"
        aria-label="Test scanner input"
        className="lux-input w-full font-mono"
        placeholder="Click here, then scan a barcode"
        autoComplete="off"
      />

      {result && (
        <p
          role="status"
          className={`rounded-lg border p-3 text-xs font-semibold ${
            result.ok
              ? 'border-[var(--jade)] bg-[var(--jade)]/10 text-[var(--jade)]'
              : 'border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]'
          }`}
        >
          {result.chars} characters · average {result.avgGap} ms between them. {result.verdict}
        </p>
      )}
    </section>
  );
}

/** Lists products with no barcode, with a button to issue codes in bulk. */
export function AdminBarcodeAssignScreen(): React.ReactElement | null {
  const store = useStore();
  const { showAlert } = useAlert();
  const [assigning, setAssigning] = useState(false);

  const missing = store.products.filter((product: Product) => !String(product.barcode || '').trim());

  if (!missing.length) return null;

  const assign = async () => {
    setAssigning(true);
    try {
      const result = await api.post<{ assigned: Array<{ id: string; barcode: string }> }>(
        '/products?assignBarcodes=true',
        {},
      );
      showAlert(`${result.assigned.length} barcode${result.assigned.length === 1 ? '' : 's'} issued.`, 'success');
      await store.fetchProducts({ includeUnpublished: true });
    } catch (error: any) {
      showAlert(error?.data?.error || error?.message || 'Could not issue barcodes.', 'error');
    } finally {
      setAssigning(false);
    }
  };

  return (
    <section className="lux-card space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-[var(--text-primary)]">
            {missing.length} product{missing.length === 1 ? '' : 's'} without a barcode
          </h3>
          <p className="text-[11px] text-[var(--text-subtle)]">
            Codes are issued in order and never reused, so a label can always be traced back.
          </p>
        </div>
        <button onClick={() => void assign()} disabled={assigning} className="lux-btn lux-btn--primary lux-btn--sm">
          {assigning ? 'Issuing…' : 'Issue barcodes'}
        </button>
      </div>
    </section>
  );
}

/** Previews the next code that would be issued, without allocating it. */
export function nextCodePreview(taken: Iterable<string>): string {
  return nextInternalBarcode(taken);
}