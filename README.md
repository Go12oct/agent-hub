# Agent Hub

One live feed for coding-agent sessions on your Windows PC, Android phone, and
desktop browser. Agent Hub runs locally on your computer and serves its own
web interface; the Android app connects to that daemon over your LAN or
Tailscale.

## Windows quick start

1. Download `agent-hub-windows.zip` from the project's GitHub Releases page
   and unzip it.
2. Double-click **Install-AgentHub.cmd** in the extracted folder. The installer
   sets Agent Hub to start when you sign in and adds a tray icon. It does not
   need Node.js, npm, or administrator access. If Windows does not allow a
   Scheduled Task, it uses your per-user Startup folder instead.
3. Download **agent-hub-android.apk** from the same release and install it on
   your phone. Android may ask you to allow installation from that source.
   The first release-signed APK requires a one-time uninstall of any earlier
   Agent Hub APK and a new pairing; subsequent updates install over it.
4. Right-click the Agent Hub tray icon and choose **Pair phone**. Scan the QR
   code shown in the opened terminal window with Agent Hub on your phone.

The desktop browser view is at <http://localhost:4747>. To remove Agent Hub,
double-click **Uninstall-AgentHub.cmd** in the extracted folder. Your
configuration and agent transcripts are left untouched.

The daemon's configuration and random access token are stored in
`%APPDATA%\agent-hub\config.json`. Keep this file private. The token is never
printed by the daemon or included in routine logs; the pairing QR code
contains it for setup.

### Troubleshooting phone connections

The PC and phone must be on the same reachable Wi-Fi or Tailscale network. If
the phone cannot connect, choose the PC's Wi-Fi address when pairing. Avoid
hotspot, virtual-adapter, and `169.254.x.x` addresses. If Windows Firewall
permission was declined, ask an administrator to run `agent-hub firewall`.
The rule allows the local subnet and Tailscale's `100.64.0.0/10` range.
For access away from home, follow the [Tailscale setup guide](docs/tailscale.md).

### Notifications with ntfy

Install the ntfy Android app (free, from F-Droid or GitHub Releases; no Play
Store needed), subscribe to a private topic, and configure it with
`agent-hub config set ntfy.topic <topic>`. Agent Hub publishes transitions to
needs-input, done, and error to `https://ntfy.sh/<topic>`, and each permission
request Claude Code makes. Tapping an alert opens that chat in Agent Hub
(`agenthub://session/<id>`). Anyone who knows a public ntfy topic can read
messages sent to it; choose a hard-to-guess topic, or point Agent Hub at your
own server with `agent-hub config set ntfy.server https://ntfy.example.com`.
Only the agent name, project, status and a one-line summary are sent; the
transcript stays on your PC.

### Claude Code approvals

After `agent-hub install-claude-hooks`, Claude Code's `PermissionRequest` hook
waits on Agent Hub. The chat shows what Claude wants to run with Allow and Deny
buttons; your answer is returned to Claude as the hook decision. If you do not
answer within five minutes (`agent-hub config set approvals.holdSeconds 300`),
Claude falls back to its normal prompt on the PC, and anything answered on the
PC first clears the request on the phone. Nothing is approved automatically.
Set `approvals.enabled false` to go back to notify-only.

### Codex approvals

When Codex is installed, the Windows installer adds Agent Hub hooks to its
existing hooks file without removing other tools' entries. Open Codex and run
`/hooks` once to trust the hooks. Codex asks for permission through Agent Hub
when a tool approval is actually requested; hooks will not fire when
`approval_policy = "never"` prevents permission prompts.

## Agent support

| Agent interface | View sessions | Send replies | Allow / Deny |
| --- | --- | --- | --- |
| Claude Code terminal or IDE | Yes | Yes | Yes, through hooks |
| Codex CLI | Yes | Yes | Yes, through hooks |
| Antigravity `agy` CLI | Yes | Yes | — |
| Antigravity desktop app | Yes | — | — |
| Devin | Yes | Yes | — |

Devin waiting/blocked states are shown as **Done**; they do not create a
“Needs you” state. Codex Cloud polling is an optional, experimental view of
Codex backend tasks and is disabled by default.

Agent Hub does not collect ChatGPT web conversations or upload local agent
transcripts to a hosted service. Configure optional cloud integrations only if
you accept their respective provider/API terms.

## Development

Requirements: Node.js 22+, Java 21, and Android SDK platform/build tools 35 for
local Android builds. The barcode-scanner plugin's Android build uses a Java 21
toolchain. The Android command-line tools are installed under `~/android-sdk`
on the development box.

```sh
npm ci
npm run typecheck
npm test
npm run build
npx cap sync android
cd android && ./gradlew assembleDebug
```

`npm run build` creates the Vite web app, copies it into the daemon's static
directory, and bundles the Node daemon. `npm run dev -w app` starts the web
development server. The daemon can also be started with `npm run dev -w daemon`.
The daemon defaults to port 4747 and binds to `0.0.0.0`; use a trusted LAN or
Tailscale network because the Android client uses HTTP for local connectivity.

For development/test environments:

- `AGENT_HUB_CONFIG_DIR` overrides the configuration directory.
- `AGENT_HUB_HOME` overrides the home directory used to locate agent data.
- `AGENT_HUB_PORT` and `DEVIN_API_KEY` override configuration values.
- `CODEX_HOME` overrides the Codex data directory.

## Data and security

The app sends the bearer token over the local network to authenticate requests.
The pairing URL format is `agenthub://pair?url=<encoded-url>&token=<token>`.
API routes require a bearer token (or a query token for EventSource clients);
`/health` is unauthenticated. Treat the pairing QR code as a credential and
re-pair after sharing it unintentionally. Agent Hub is intended for a private,
trusted network, not direct exposure to the public internet.

The file collectors retain only session summaries in memory and parse a
bounded portion of large transcript files. Message detail requests read up to
the most recent 30 messages by default.
