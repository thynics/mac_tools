#!/bin/zsh

set -u
umask 077
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

typeset -gr VPN_SETTING_DIR="${0:A:h}"
source "${VPN_SETTING_DIR}/lib-vpn-setting.zsh" || exit 1
source "${VPN_SETTING_DIR}/proxy-recovery.zsh" || exit 1

vpn_prepare_runtime_dirs || exit 1
[[ "$(vpn_read_mode)" == "company" ]] || exit 0

typeset -g WAITER_LAST_MESSAGE=""
typeset -g WAITER_HEALTHY=0
typeset -g WAITER_DNS_SIGNATURE="$(vpn_dns_signature)"
typeset -g WAITER_LAST_RESTART=-1000
typeset -g WAITER_RESTART_BACKOFF=30

if ! vpn_guard_refresh_proxy_dns "$WAITER_DNS_SIGNATURE"; then
  vpn_warn "代理节点 DNS 配置暂未刷新；保留当前配置"
  WAITER_DNS_SIGNATURE="unapplied"
fi

waiter_report() {
  if [[ "$*" != "$WAITER_LAST_MESSAGE" ]]; then
    vpn_log "$*"
    WAITER_LAST_MESSAGE="$*"
  fi
}

# Restart only for a missing listener.
# Business endpoint probe failures use in-place recovery below.
waiter_restart_mihomo() {
  local reason="$1"
  (( SECONDS - WAITER_LAST_RESTART >= WAITER_RESTART_BACKOFF )) || return 2
  WAITER_LAST_RESTART=$SECONDS
  vpn_log "刷新 Mihomo：${reason}"
  vpn_restart_mihomo || return 1
  vpn_wait_for_mihomo_listening 15
}

while [[ "$(vpn_read_mode)" == "company" ]]; do
  network_service="$(vpn_detect_network_service)" || {
    waiter_report "无法识别承载网络服务，30 秒后重试"
    /bin/sleep 30
    continue
  }
  VPN_PROXY_SERVICE="$network_service"

  # Restore a missing listener before any operation requiring its controller.
  if ! vpn_mihomo_listening; then
    WAITER_HEALTHY=0
    WAITER_LAST_RESTART=-1000
    waiter_restart_mihomo "127.0.0.1:8119 未监听" || true
    /bin/sleep 10
    continue
  fi

  # Rebuild only the proxy-node resolver when GlobalProtect changes DNS.
  # Hot reload preserves the listener; ordinary probes never restart it.
  dns_now="$(vpn_dns_signature)"
  if [[ "$dns_now" != "$WAITER_DNS_SIGNATURE" ]]; then
    WAITER_HEALTHY=0
    vpn_guard_note_success
    if vpn_guard_refresh_proxy_dns "$dns_now"; then
      WAITER_DNS_SIGNATURE="$dns_now"
    else
      vpn_warn "DNS 变化尚未应用；保留代理进程并稍后重试"
    fi
    /bin/sleep 5
    continue
  fi

  # This background helper never rewrites macOS network settings. A mismatch
  # is surfaced and left for the foreground switch command.
  if ! vpn_company_system_proxy_matches; then
    WAITER_HEALTHY=0
    waiter_report "物理网络服务保存的代理不是公司配置；请运行 install.command"
    /bin/sleep 30
    continue
  fi
  if ! vpn_effective_company_proxy_compatible 2>/dev/null; then
    WAITER_HEALTHY=0
    if vpn_vpn_owns_proxies; then
      waiter_report "$(vpn_gp_reconnect_hint)"
    else
      waiter_report "实际生效代理不是 127.0.0.1:8119；请运行 install.command"
    fi
    /bin/sleep 30
    continue
  fi

  # Steady state: one lightweight HTTPS probe per minute proves both the GP
  # underlay and the selected KIX node.
  if vpn_guard_proxy_ready; then
    if ! vpn_company_env_matches; then
      vpn_acquire_transition_lock || exit 1
      if [[ "$(vpn_read_mode)" == "company" ]]; then
        vpn_install_codex_env "${VPN_SETTING_DIR}/codex.env.corporate" || \
          waiter_report "公司代理链路健康，但 Codex .env 代理键合并失败"
      fi
      vpn_release_transition_lock
    fi
    WAITER_HEALTHY=1
    vpn_guard_note_success
    waiter_report "OpenAI 经 KIX 链路健康（API 401，AUTO=$(vpn_mihomo_group_now AUTO)）；现有连接保持"
    /bin/sleep 60
    continue
  fi

  WAITER_HEALTHY=0
  vpn_guard_handle_probe_failure
  /bin/sleep 20
done

exit 0
