import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NtExecutable, NtExecutableResource } from 'pe-library';
import { Resource } from 'resedit';

const buildScript = '../scripts/build-sea.mjs';

const mocks = vi.hoisted(() => ({
  copyFile: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => mocks);
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));

describe('Windows SEA build', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    const image = NtExecutable.createEmpty(false, false);
    const resources = NtExecutableResource.from(image);
    const upstream = Resource.VersionInfo.createEmpty();
    upstream.setStringValues({ lang: 1033, codepage: 1200 }, { ProductName: 'Node.js', CompanyName: 'OpenJS' });
    upstream.outputToResourceEntries(resources.entries);
    resources.outputResource(image);
    mocks.readFile.mockImplementation(async (file: string) => file.endsWith('package.json')
      ? JSON.stringify({ version: '0.2.4' })
      : file.endsWith('LICENSE')
        ? 'MIT License\r\n\r\nCopyright (c) 2025 Agent Hub contributors\r\n'
        : Buffer.from(image.generate()));
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, '', ''));
  });

  it('sets application version resources after copying Node and before injection', async () => {
    await import(buildScript);
    const [executable, data] = mocks.writeFile.mock.calls.find(([file]) => file.endsWith('.exe'))!;
    expect(executable).toMatch(/agent-hub\.exe$/);
    const resources = NtExecutableResource.from(NtExecutable.from(data));
    const versions = Resource.VersionInfo.fromEntries(resources.entries);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.lang).toBe(1033);
    expect(versions[0]!.getAvailableLanguages()).toEqual([{ lang: 1033, codepage: 1200 }]);
    expect(versions[0]!.getStringValues({ lang: 1033, codepage: 1200 })).toEqual({
      ProductName: 'Agent Hub',
      FileDescription: 'Agent Hub daemon',
      CompanyName: 'Agent Hub contributors',
      LegalCopyright: 'Copyright (c) 2025 Agent Hub contributors',
      OriginalFilename: 'agent-hub.exe',
      InternalName: 'agent-hub',
      FileVersion: '0.2.4',
      ProductVersion: '0.2.4',
    });
    expect(versions[0]!.fixedInfo.fileVersionMS).toBe(2);
    expect(versions[0]!.fixedInfo.fileVersionLS).toBe(4 << 16);
    expect(versions[0]!.fixedInfo.productVersionMS).toBe(2);
    expect(versions[0]!.fixedInfo.productVersionLS).toBe(4 << 16);
    expect(mocks.copyFile.mock.invocationCallOrder[0]).toBeLessThan(mocks.writeFile.mock.invocationCallOrder[1]!);
    expect(mocks.writeFile.mock.invocationCallOrder[1]).toBeLessThan(mocks.execFile.mock.invocationCallOrder[1]!);
    expect(mocks.rm).toHaveBeenCalledTimes(2);
  });

  it('rejects an empty copyright notice and cleans temporary files', async () => {
    mocks.readFile.mockResolvedValueOnce('{"version":"0.2.4"}').mockResolvedValueOnce('');
    await expect(import(buildScript)).rejects.toThrow('LICENSE copyright notice missing');
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.rm).toHaveBeenCalledTimes(2);
  });

  it('does not inject after metadata editing fails and cleans temporary files', async () => {
    mocks.readFile.mockResolvedValueOnce('{"version":"0.2.4"}')
      .mockResolvedValueOnce('Copyright (c) 2025 Agent Hub contributors')
      .mockResolvedValueOnce(Buffer.from('invalid PE'));
    await expect(import(buildScript)).rejects.toThrow();
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.rm).toHaveBeenCalledTimes(2);
  });
});
