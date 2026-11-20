#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID != 0 || $# != 2 || ! $1 =~ ^[a-zA-Z0-9]+[a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ || ! -f $2 ]]; then
  echo "Usage: sudo bash setup.sh relay.example.com /path/to/relay.cjs" >&2
  exit 1
fi
hostname=$1
bundle=$(realpath "$2")
case "$(uname -m)" in
  aarch64) architecture=arm64 ;;
  x86_64) architecture=x64 ;;
  *) echo "Unsupported VM architecture." >&2; exit 1 ;;
esac

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl xz-utils caddy iptables-persistent

temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
distribution=https://nodejs.org/dist/latest-v24.x
curl -fSsL "$distribution/SHASUMS256.txt" -o "$temporary/SHASUMS256.txt"
node_release=$(awk -v arch="$architecture" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {print $2}' "$temporary/SHASUMS256.txt")
[[ -n $node_release ]]
curl -fSsL "$distribution/$node_release" -o "$temporary/$node_release"
(cd "$temporary" && awk -v file="$node_release" '$2 == file' SHASUMS256.txt | sha256sum --check)
install -d -m 0755 /opt/agent-hub-relay
tar -xJf "$temporary/$node_release" --strip-components=2 -C "$temporary" "${node_release%.tar.xz}/bin/node"
install -m 0755 "$temporary/node" /opt/agent-hub-relay/node
install -m 0644 "$bundle" /opt/agent-hub-relay/relay.cjs

cat >/etc/systemd/system/agent-hub-relay.service <<'EOF'
[Unit]
Description=Agent Hub relay
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/opt/agent-hub-relay/node /opt/agent-hub-relay/relay.cjs
Environment=RELAY_TRUST_PROXY=1
DynamicUser=yes
Restart=on-failure
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/caddy/Caddyfile <<EOF
$hostname {
  reverse_proxy 127.0.0.1:8787 {
    header_up X-Agent-Hub-Client-IP {remote_host}
  }
}
EOF
caddy validate --config /etc/caddy/Caddyfile

# OCI's Ubuntu image can reject all traffic not explicitly accepted earlier.
if ! iptables -C INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT 2>/dev/null; then
  iptables -I INPUT 1 -p tcp -m multiport --dports 80,443 -j ACCEPT
fi
netfilter-persistent save
systemctl daemon-reload
systemctl enable agent-hub-relay caddy
systemctl restart agent-hub-relay caddy
echo "Relay installed. Once TLS is issued, verify: curl --fail https://$hostname/health"
