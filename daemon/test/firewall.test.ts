import { describe, expect, it } from 'vitest';
import { firewallRuleScript } from '../src/firewall.js';

describe('Windows Firewall rule script', () => {
  it('uses the configured port and limits access to LAN and Tailscale peers', () => {
    const script = firewallRuleScript(4319);

    expect(script).toContain('$port = 4319');
    expect(script).toContain('$_.Enabled -eq \'True\'');
    expect(script).toContain('$portFilter.Protocol -eq \'TCP\'');
    expect(script).toContain('$portFilter.LocalPort) -contains "$port"');
    expect(script).toContain('-LocalPort 4319');
    expect(script).toContain("-RemoteAddress @('LocalSubnet', '100.64.0.0/10')");
  });
});
