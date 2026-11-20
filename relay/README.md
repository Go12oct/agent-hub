# Host the Agent Hub relay on Oracle Cloud Always Free

The PC daemon and the phone both make outbound connections to your relay. A
customer scans the normal Agent Hub QR code: no Tailscale, additional app,
new account, or inbound port on their PC is required. Local Wi-Fi and existing
Tailscale connections still work.

## 1. Create a free VM

1. In your OCI home region, create a dedicated Ubuntu 24.04 VM with an
   **Always Free eligible** shape: VM.Standard.A1.Flex (for example, 1 OCPU
   and 1 GB RAM) or VM.Standard.E2.1.Micro. Keep the boot volume at its
   default minimum size and within your tenancy's Always Free allowance. Do
   not upgrade to a paid tenancy or choose paid shapes, load balancers, or
   add-ons. Check the estimate and eligibility in the console before creating
   it. Capacity is not guaranteed, and Oracle can reclaim idle free instances.
2. Use a public subnet with an internet gateway and assign a public IPv4
   address. Add **stateful ingress TCP 80 and 443** from `0.0.0.0/0` in the
   subnet security list or the VM's network security group. Keep TCP 22
   limited to your admin IP where possible. Do not open 8787 or 4747.
3. Point an **A record** at the public IP, for example using a free DuckDNS
   name. A name such as `<public-ip-with-dashes>.sslip.io` can also resolve
   without buying a domain, subject to that provider's availability and
   certificate issuance limits. Verify the name resolves to the VM before
   continuing.

## 2. Install the relay

On your development machine, from the repository root with Node 22 or later:

```sh
npm ci
npm run build -w relay
scp relay/dist/relay.cjs relay/deploy/setup.sh ubuntu@<public-ip>:~/
```

SSH into the VM and run (replace the example name with yours):

```sh
sudo bash setup.sh relay.example.com ~/relay.cjs
curl --fail https://relay.example.com/health
```

Use a dedicated VM: the script installs Node 24 and Caddy, replaces
`/etc/caddy/Caddyfile`, and persists the Ubuntu firewall rules for 80 and 443.
The service listens on loopback only; Caddy provides public HTTPS and WSS with
automatically renewed certificates. If health does not return `ok`, check DNS,
both OCI ingress rules and `sudo journalctl -u caddy -u agent-hub-relay -n 50`.
To update, copy the new bundle and rerun setup. Do not turn on URL access logs:
the EventSource URL includes a pairing token.

## 3. Enable remote pairing

Windows releases use [the hosted Agent Hub relay](https://92-5-42-80.sslip.io/health)
by default. Customers can scan the normal pairing QR without configuring a
relay address. To ship releases that use your own relay instead, set the
optional GitHub Actions repository variable `AGENT_HUB_DEFAULT_RELAY_URL` to
its HTTPS origin. Local builds have no bundled relay unless you set the same
environment variable when running `npm run build:daemon`.

To enable the relay on an installed PC or override the release default:

```sh
agent-hub config set relayUrl https://relay.example.com
```

On a Windows ZIP install, run the same command with the installed executable
(PowerShell: `& "$env:LOCALAPPDATA\agent-hub\agent-hub.cmd" config set relayUrl https://relay.example.com`).
Restart Agent Hub and use **Pair phone** in the tray (or `agent-hub pair`).
Scan the QR with the updated phone app, turn off phone Wi-Fi, and check that
the live feed still updates. An existing phone pairing can also pick up the
relay automatically the next time it connects directly to that PC.

`AGENT_HUB_RELAY_URL` can override `relayUrl` and the bundled default when it
is available to both the daemon and pairing
command. Set `relayUrl` to `false` and restart to disable the tunnel.

## Trust and limits

HTTPS/WSS protects traffic in transit; the relay terminates TLS and can see
the pairing token and session traffic. This is **not end-to-end encrypted**:
only use a relay you trust. The relay keeps routing in memory, not on disk.
It exposes only the paired app's API, not the daemon's static web server,
hook endpoints, or shutdown endpoint. Keep the PC online for remote access.
The service caps simultaneous tunnels and requests and rate-limits clients;
an Always Free VM is intended for small deployments, not unlimited traffic.

For a private relay serving known PCs, set `RELAY_ALLOWED_HUB_IDS` in a
systemd drop-in (`sudo systemctl edit agent-hub-relay`) and restart the service.
Add `[Service]`, then `Environment=RELAY_ALLOWED_HUB_IDS=<id>,<id>` with each
PC's lowercase SHA-256 hash of its `relay-key` file (next to `config.json`).
Share only the hash, not the file or pairing QR. This permits only those
PCs to register while leaving phone pairing and sign-in unchanged. Without
an allowlist, open enrollment caps each source IPv4 address or IPv6 /64 to eight simultaneous
registrations but does not prevent distributed clients from consuming capacity.
