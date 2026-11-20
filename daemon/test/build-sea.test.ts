import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildScript = '../scripts/build-sea.mjs';

const mocks = vi.hoisted(() => ({
  copyFile: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
  execFile: vi.fn(),
  rcedit: vi.fn(),
}));

vi.mock('node:fs/promises', () => mocks);
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('rcedit', () => ({ rcedit: mocks.rcedit }));

describe('Windows SEA build', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.readFile.mockImplementation(async (file: string) => file.endsWith('package.json')
      ? JSON.stringify({ version: '0.2.4' })
      : 'MIT License\r\n\r\nCopyright (c) 2025 Agent Hub contributors\r\n');
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, '', ''));
  });

  it('sets application version resources after copying Node and before injection', async () => {
    await import(buildScript);
    expect(mocks.rcedit).toHaveBeenCalledWith(expect.stringMatching(/agent-hub\.exe$/), {
      'version-string': {
        ProductName: 'Agent Hub',
        FileDescription: 'Agent Hub daemon',
        CompanyName: 'Agent Hub contributors',
        LegalCopyright: 'Copyright (c) 2025 Agent Hub contributors',
        OriginalFilename: 'agent-hub.exe',
        InternalName: 'agent-hub',
      },
      'file-version': '0.2.4',
      'product-version': '0.2.4',
    });
    expect(mocks.copyFile.mock.invocationCallOrder[0]).toBeLessThan(mocks.rcedit.mock.invocationCallOrder[0]!);
    expect(mocks.rcedit.mock.invocationCallOrder[0]).toBeLessThan(mocks.execFile.mock.invocationCallOrder[1]!);
    expect(mocks.rm).toHaveBeenCalledTimes(2);
  });

  it('rejects an empty copyright notice and cleans temporary files', async () => {
    mocks.readFile.mockResolvedValueOnce('{"version":"0.2.4"}').mockResolvedValueOnce('');
    await expect(import(buildScript)).rejects.toThrow('LICENSE copyright notice missing');
    expect(mocks.rcedit).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledTimes(2);
  });

  it('does not inject after metadata editing fails and cleans temporary files', async () => {
    mocks.rcedit.mockRejectedValueOnce(new Error('Resource edit failed'));
    await expect(import(buildScript)).rejects.toThrow('Resource edit failed');
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.rm).toHaveBeenCalledTimes(2);
  });
});
