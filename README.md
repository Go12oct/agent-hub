# Agent Hub

One live feed for coding-agent sessions on your Windows PC, Android phone, and
desktop browser. Agent Hub runs locally on your computer and serves its own
web interface; the Android app connects to that daemon over your LAN or
Tailscale.

## Windows quick start

1. Install Node.js 22 or newer (Node LTS).
2. Download and extract the latest `agent-hub-windows.zip`, then run:

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\agent-hub\scripts\install.ps1
   ```

   The installer copies the daemon to `%LOCALAPPDATA%\agent-hub`, tries to
   register an `AgentHub` Scheduled Task at logon, installs Claude Code hooks,
   and prints a QR pairing code. If Windows denies Scheduled Task creation
   without admin rights, Agent Hub uses the current user's Startup folder
   instead. If the release includes a standalone executable, Node.js is not
   required. For a source checkout, run `npm ci` and `npm run build` first.
3. Optional integrations:

   ```powershell
   agent-hub config set devinApiKey apk_user_...
   agent-hub config set ntfy.topic my-private-agent-hub-topic
   agent-hub config set codexCloud.enabled true
   ```

   Then run `agent-hub pair` to print the QR code and LAN addresses again.
4. Install the Agent Hub APK on Android and scan the pairing QR code. The
   desktop browser UI is served by the daemon at `http://localhost:4747`.

The daemon's configuration and random access token are stored in
`%APPDATA%\agent-hub\config.json`. Keep this file private. The token is never
printed by the daemon or included in routine logs; `agent-hub pair` displays it
inside the pairing QR code for setup.

### Remote access with Tailscale

For access away from home, install Tailscale on the Windows PC and Android
phone, sign both into the same tailnet, and run `agent-hub pair`. It includes
any detected Tailscale `100.x.y.z` address. Use that URL when pairing. Agent
Hub does not provide a cloud relay; the PC must be online and the daemon
running. Tailscale's personal plan is free for typical personal use.

### Optional background push

Install the ntfy Android app, choose a private topic, and configure it with
`agent-hub config set ntfy.topic <topic>`. Agent Hub publishes transitions to
needs-input, done, and error to `https://ntfy.sh/<topic>`. Anyone who knows a
public ntfy topic can read messages sent to it; choose a hard-to-guess topic or
configure a private ntfy server.

## Supported sources

| Agent | Data collected | Notes |
| --- | --- | --- |
| Codex CLI, VS Code, desktop | Local rollout JSONL under `$CODEX_HOME/sessions` or `~/.codex/sessions`; archived rollouts are also scanned. | Reads bounded file head/tail chunks and rescans for updates. |
| Codex Cloud | Optional polling of the Codex backend tasks endpoint using the local Codex auth file. | Experimental, unofficial endpoint; may change or be unavailable. Disabled by default. |
| Claude Code | Local `~/.claude/projects/**` transcripts and optional HTTP hooks. | Run `agent-hub install-claude-hooks` to add hooks; `uninstall-claude-hooks` removes only Agent Hub entries. |
| Antigravity | Conversation files under `~/.gemini/antigravity-ide` (legacy `~/.gemini/antigravity`) and compatible JSONL transcripts under Antigravity brain/log directories. | The IDE stores full trajectories in SQLite `.db` files (older `.pb` protobuf); Agent Hub does not parse their opaque payloads and shows a generated title with mtime-based status. The JSONL reader supports the separately documented step/event layout where present; this format is reverse-engineered and may break after updates. |
| Devin | Optional sessions from the Devin API using a personal `apk_user_*` API key. | Configure with `agent-hub config set devinApiKey ...`. Chat history may not be available from the API account/endpoint. |

**Not supported:** ChatGPT web conversations are not exposed through a supported
local API and are not collected. Agent Hub does not upload local transcripts to
a hosted service. Configure optional cloud integrations only if you accept
their respective provider/API terms.

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
