import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { lanUrls } from '../src/server.js';

type InterfaceAddress = NonNullable<ReturnType<typeof os.networkInterfaces>[string]>[number];

function ipv4(address: string): InterfaceAddress {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/24`,
  };
}

describe('LAN pairing URLs', () => {
  it('prefers Wi-Fi over the Windows hotspot and omits link-local addresses', () => {
    const interfaces: ReturnType<typeof os.networkInterfaces> = {
      'Local Area Connection* 14': [ipv4('192.168.137.1')],
      'Wi-Fi 3': [ipv4('192.168.8.3'), ipv4('169.254.12.34')],
      'Other adapter': [ipv4('10.0.0.12')],
      'vEthernet (Default Switch)': [ipv4('172.25.0.1')],
    };

    expect(lanUrls(4747, interfaces)[0]).toBe('http://192.168.8.3:4747');
    expect(lanUrls(4747, interfaces)).toEqual([
      'http://192.168.8.3:4747',
      'http://10.0.0.12:4747',
      'http://192.168.137.1:4747',
      'http://172.25.0.1:4747',
    ]);
  });

  it('ranks Tailscale addresses ahead of physical LAN adapters', () => {
    const interfaces: ReturnType<typeof os.networkInterfaces> = {
      'Wi-Fi 3': [ipv4('192.168.8.3')],
      Tailscale: [ipv4('100.80.0.7')],
    };

    expect(lanUrls(4747, interfaces)[0]).toBe('http://100.80.0.7:4747');
  });
});
