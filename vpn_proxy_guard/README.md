# ChinaProxy watchdog recovery

Repairs an existing `~/vpn_setting` ChinaProxy installation that routes traffic
through Mihomo at `127.0.0.1:8119`. A failed OpenAI probe used to invoke
`brew services restart mihomo`, dropping active streams and briefly refusing
all new proxy connections.

The watchdog now confirms three consecutive failures, clears the DNS answer
cache through Mihomo's Unix controller, and rechecks the KIX and AUTO groups
without stopping the proxy. A business request must pass before recovery is
reported. Recovery has a five-minute cooldown, including across brief successes.
Controller failures leave the existing listener running.

OpenAI domains (`openai.com`, `chatgpt.com`, `oaistatic.com`, and
`oaiusercontent.com`) now use the KIX fallback pool directly. AUTO can still
fall back to DIRECT for ordinary traffic without moving OpenAI onto an exit
that returns `unsupported_country_region_territory`. Internal and VPN login
exceptions remain ahead of these rules. Non-443 traffic outside those domains
uses DIRECT, since the corporate HTTP proxies reject CONNECT to those ports;
unrelated HTTP and push requests no longer trigger pool-wide health checks.

KIX health checks require the expected anonymous API `401`, rather than treating
a region-block `403` as healthy. Checks run every minute, and failure-triggered
checks use a threshold of five. The watchdog checks the OpenAI request itself,
so AUTO being on DIRECT is not by itself a reason to recover the proxy.

A missing listener still triggers recovery immediately. Proxy hostnames use TCP
DNS through the current system DNS servers that pass a corporate-name lookup.
This avoids the intermittent cold-cache UDP lookup timeouts observed in Mihomo
1.19.32. Other names keep the system resolver; no DNS listener is opened.

At startup and when GlobalProtect changes the system DNS servers, the watchdog
generates and validates a candidate, backs up the current configuration, and
hot-loads it with `force=false`. The existing listener stays open. Home networks
without a working corporate TCP resolver fall back to system DNS. Changes share
ChinaProxy's mode-transition lock; a failed reload restores the saved file.

This patch expects the existing `lib-vpn-setting.zsh`, a Unix controller at
`mihomo.sock`, a KIX fallback group using `https://api.openai.com/v1/models`, and
an AUTO group using `https://www.apple.com/library/test/success.html`. Unsupported
or ambiguous configuration layouts are rejected before replacement. macOS
proxy settings, account credentials, system routes, and the library stay in place.

```sh
zsh vpn_proxy_guard/tests/test-recovery.zsh
python3 vpn_proxy_guard/tests/test-proxy-dns.py
zsh vpn_proxy_guard/install.zsh
```

Installation backs up the replaced scripts under `~/vpn_setting/install-backups`
and restarts only the watchdog LaunchAgent. The installed Mihomo template is
also patched so a later mode switch retains the routing fix. Mihomo configuration backups are
under `~/vpn_setting/backups/mihomo-before-guard-*.yaml`. To roll back the watchdog,
restore the saved `wait-for-globalprotect.zsh` and template `mihomo-config.yaml`, then run:

```sh
launchctl kickstart -k "gui/$(id -u)/com.nvidia.chinaproxy.bootstrap"
```

The companion files can remain unused after restoring the old watchdog. To also
revert active DNS/routing, restore the corresponding configuration backup to
`/opt/homebrew/etc/mihomo/config.yaml` and reload it through Mihomo's controller.
An older ChinaProxy installer replaces the watchdog; rerun this patch after
installing such a version.

Validation includes 12 mocked watchdog cases, 21 candidate-generation and routing
tests, and Mihomo's own configuration validation. Live verification additionally
forces AUTO to DIRECT in an isolated instance, checks that OpenAI still exits
through Japan, and confirms non-443 traffic uses DIRECT. A persistent API tunnel
is used to verify that hot reload and in-place recovery preserve the listener
process and the existing TLS connection.

References: [Mihomo controller API](https://wiki.metacubex.one/api/),
[system resolver implementation](https://github.com/MetaCubeX/mihomo/blob/v1.19.32/dns/system_common.go).
