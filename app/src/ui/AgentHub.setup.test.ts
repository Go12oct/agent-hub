// @vitest-environment happy-dom

import { Capacitor } from '@capacitor/core';
import { CapacitorBarcodeScanner } from '@capacitor/barcode-scanner';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHub } from './AgentHub';

vi.mock('@capacitor/barcode-scanner', () => ({
  CapacitorBarcodeScanner: { scanBarcode: vi.fn() },
  CapacitorBarcodeScannerTypeHint: { QR_CODE: 0 },
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn().mockResolvedValue({ value: null }) },
}));

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('pairing scanner', () => {
  it.each([
    { outcome: 'cancellation', code: 'OS-PLUG-BARC-0006', showsError: false },
    { outcome: 'camera permission denial', code: 'OS-PLUG-BARC-0007', showsError: true },
  ])('handles $outcome', async ({ code, showsError }) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    const scanBarcode = vi.mocked(CapacitorBarcodeScanner.scanBarcode);
    scanBarcode.mockClear();
    scanBarcode.mockRejectedValueOnce(Object.assign(new Error(), { code }));

    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(AgentHub)));

    const scan = container.querySelector<HTMLButtonElement>('button.primary');
    expect(scan?.textContent).toContain('Scan QR code');
    await act(async () => {
      scan?.click();
      await vi.waitFor(() => expect(scanBarcode).toHaveBeenCalledOnce());
    });

    expect(container.querySelector('.alert')?.textContent).toBe(
      showsError ? 'Could not open the camera. Paste the pairing link instead.' : undefined,
    );
    expect(Boolean(container.querySelector('.manual'))).toBe(showsError);
  });
});
