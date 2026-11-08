# Use Agent Hub away from home with Tailscale

Tailscale gives your PC and phone a private network connection without
forwarding a port on your router. Agent Hub must be running on the PC, and
both devices must be online.

## Set it up

1. Install Tailscale on the Windows PC from [tailscale.com/download](https://tailscale.com/download).
2. Install the Tailscale app on the Android phone.
3. Sign both devices into the same Tailscale account and approve the VPN
   connection on Android. Keep Tailscale connected on both devices.
4. On the PC, open PowerShell and run:

   ```powershell
   tailscale ip -4
   ```

   Note the PC's `100.x.y.z` address.
5. In PowerShell, print a pairing QR with the Tailscale address first:

   ```powershell
   agent-hub pair --url http://100.x.y.z:4747
   ```

   Replace `100.x.y.z` with the address from the previous step. You can also
   right-click the Agent Hub tray icon and choose **Pair phone**; the QR
   includes the detected Tailscale address along with other available PC
   addresses.
6. Open Agent Hub on the phone, scan the QR, and confirm that it connects.
   You can now use the same phone connection away from home while Tailscale
   remains connected.

The Agent Hub firewall rule allows Tailscale's `100.64.0.0/10` address range.
If the rule was not added during installation, ask an administrator to run
`agent-hub firewall`.

## If the phone cannot connect

- Confirm Tailscale shows both devices as connected to the same tailnet.
- On the phone, open `http://100.x.y.z:4747/health` in a browser, replacing
  the address with the PC's Tailscale IP. A running daemon responds with
  `{"ok":true,"service":"agent-hub"}`.
- Android can use only one active VPN connection at a time. Disconnect other
  VPNs, work profiles with an always-on VPN, or ad-blocking apps that create a
  VPN while using Tailscale.
- Keep the PC awake and Agent Hub running. Agent Hub has no cloud relay.

Treat the pairing QR as a credential and keep access limited to your private
tailnet. Do not expose Agent Hub directly to the public internet.
