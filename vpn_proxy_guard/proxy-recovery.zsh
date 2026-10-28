#!/bin/zsh

# Loaded after ChinaProxy's lib-vpn-setting.zsh. Ordinary probe failures must
# never remove the proxy listener or interrupt established response streams.
typeset -gi VPN_GUARD_FAILURES=0
typeset -gi VPN_GUARD_FAILURE_THRESHOLD=3
typeset -gi VPN_GUARD_LAST_RECOVERY=-1000
typeset -gi VPN_GUARD_RECOVERY_COOLDOWN=300

# OpenAI has its own KIX route now. AUTO may legitimately use DIRECT for
# ordinary traffic while a VPN is reconnecting; that is not a Codex outage.
vpn_guard_proxy_ready() {
  local api_code
  api_code="$(vpn_http_code_through "$VPN_LOCAL_PROXY" "$VPN_OPENAI_PROBE_URL")"
  [[ "$api_code" == 401 ]]
}

# Use TCP only for system DNS servers that can currently resolve the corporate
# proxy. Home routers need not support TCP DNS; they retain the system fallback.
vpn_guard_refresh_proxy_dns() {
  local refresh_rc=0
  vpn_acquire_transition_lock || return 1
  if [[ "$(vpn_read_mode)" == company ]]; then
    vpn_guard_refresh_proxy_dns_locked "$1" || refresh_rc=$?
  fi
  vpn_release_transition_lock
  return "$refresh_rc"
}

vpn_guard_refresh_proxy_dns_locked() {
  local signature="$1" server answer expected answers usable=""
  local candidate saved_config reload_code rollback_file
  expected="$(vpn_resolve_ipv4 "${VPN_KIX_HOSTS[1]}")"
  if [[ -n "$expected" ]]; then
    for server in "${(@s:,:)signature}"; do
      [[ -n "$server" ]] || continue
      [[ "$server" == *%* ]] && continue
      answers=$(/usr/bin/dig +tcp +short +time=1 +tries=1 \
        "@${server}" "${VPN_KIX_HOSTS[1]}" A 2>/dev/null) || continue
      for answer in "${(@f)answers}"; do
        if [[ "$answer" == "$expected" ]]; then
          usable="${usable:+${usable},}${server}"
          break
        fi
      done
    done
  fi

  candidate=$(/usr/bin/mktemp "${VPN_MIHOMO_CONFIG_TARGET}.guard.XXXXXX") || return 1
  if ! /usr/bin/python3 "${VPN_SETTING_DIR}/proxy-dns.py" \
      "$VPN_MIHOMO_CONFIG_TARGET" "$usable" --stabilize-routing --output "$candidate" >/dev/null; then
    /bin/rm -f "$candidate"
    return 1
  fi
  if /usr/bin/cmp -s "$candidate" "$VPN_MIHOMO_CONFIG_TARGET"; then
    /bin/rm -f "$candidate"
    return 0
  fi
  if ! "$VPN_MIHOMO_BIN" -t -d "${VPN_MIHOMO_CONFIG_TARGET:h}" -f "$candidate" >/dev/null 2>&1; then
    /bin/rm -f "$candidate"
    vpn_warn "DNS 候选配置未通过 Mihomo 校验；保留当前配置"
    return 1
  fi
  saved_config="${VPN_BACKUPS_DIR}/mihomo-before-guard-$(/bin/date '+%Y%m%d-%H%M%S')-$$.yaml"
  /bin/cp -p "$VPN_MIHOMO_CONFIG_TARGET" "$saved_config" || {
    /bin/rm -f "$candidate"; return 1
  }
  /bin/chmod 600 "$candidate"
  /bin/mv -f "$candidate" "$VPN_MIHOMO_CONFIG_TARGET" || return 1

  # force=false preserves the existing mixed listener and active connections.
  # JSON is generated rather than interpolating an arbitrary filesystem path.
  reload_code=$(/usr/bin/python3 -c 'import json,sys; print(json.dumps({"path":sys.argv[1]}))' \
      "$VPN_MIHOMO_CONFIG_TARGET" | \
    /usr/bin/env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
      -u http_proxy -u https_proxy -u all_proxy -u NO_PROXY -u no_proxy \
      /usr/bin/curl --silent --show-error --noproxy '*' --max-time 10 \
        --unix-socket "$VPN_MIHOMO_CONTROLLER_SOCK" --request PUT \
        --header 'Content-Type: application/json' --data-binary @- \
        --output /dev/null --write-out '%{http_code}' \
        'http://mihomo/configs?force=false') || reload_code=000
  if [[ "$reload_code" != 204 ]]; then
    rollback_file=$(/usr/bin/mktemp "${VPN_MIHOMO_CONFIG_TARGET}.rollback.XXXXXX") || {
      vpn_warn "DNS 热加载失败且无法创建回滚文件；备份：${saved_config}"; return 1
    }
    if /bin/cp -p "$saved_config" "$rollback_file" && \
        /bin/mv -f "$rollback_file" "$VPN_MIHOMO_CONFIG_TARGET"; then
      vpn_warn "DNS 热加载失败（${reload_code}）；已恢复磁盘配置，保留现有代理进程"
    else
      /bin/rm -f "$rollback_file"
      vpn_warn "DNS 热加载失败且磁盘配置回滚失败；备份：${saved_config}"
    fi
    return 1
  fi
  vpn_log "已热加载 KIX 路由与节点 DNS（${usable:+TCP }${usable:-system}）；Mihomo 监听保持"
}

vpn_guard_controller_request() {
  local method="$1" endpoint="$2" deadline="$3"
  [[ -S "$VPN_MIHOMO_CONTROLLER_SOCK" ]] || return 1
  /usr/bin/env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    -u http_proxy -u https_proxy -u all_proxy -u NO_PROXY -u no_proxy \
    /usr/bin/curl --silent --show-error --fail --noproxy '*' \
      --max-time "$deadline" --request "$method" \
      --unix-socket "$VPN_MIHOMO_CONTROLLER_SOCK" \
      "http://mihomo${endpoint}" >/dev/null
}

vpn_recover_mihomo_in_place() {
  local recovery_failed=0
  vpn_guard_controller_request POST /cache/dns/flush 3 || recovery_failed=1
  # Match each group's configured test URL. A different URL would update an
  # unrelated health record. Recheck the inner pool before its parent group.
  vpn_guard_controller_request GET \
    '/group/KIX/delay?url=https%3A%2F%2Fapi.openai.com%2Fv1%2Fmodels&timeout=5000&expected=401' \
    12 || recovery_failed=1
  vpn_guard_controller_request GET \
    '/group/AUTO/delay?url=https%3A%2F%2Fwww.apple.com%2Flibrary%2Ftest%2Fsuccess.html&timeout=5000&expected=200' \
    12 || recovery_failed=1
  return "$recovery_failed"
}

vpn_guard_note_success() {
  VPN_GUARD_FAILURES=0
  # Do not reset the recovery cooldown on one success: a flapping upstream
  # must not cause repeated recovery work every time it briefly responds.
}

vpn_guard_handle_probe_failure() {
  (( VPN_GUARD_FAILURES += 1 ))
  if (( VPN_GUARD_FAILURES < VPN_GUARD_FAILURE_THRESHOLD )); then
    waiter_report "代理探测暂时失败（${VPN_GUARD_FAILURES}/${VPN_GUARD_FAILURE_THRESHOLD}）；保留现有连接，稍后复查"
    return 0
  fi
  if (( SECONDS - VPN_GUARD_LAST_RECOVERY < VPN_GUARD_RECOVERY_COOLDOWN )); then
    waiter_report "上游仍未恢复；保留代理监听，等待下次原位恢复窗口"
    return 0
  fi

  VPN_GUARD_LAST_RECOVERY=$SECONDS
  vpn_log "代理连续探测失败；清理 DNS 缓存并重测上游，保持 Mihomo 运行"
  vpn_recover_mihomo_in_place || vpn_warn "原位恢复请求未全部成功；保留现有代理进程"
  # The controller returning 200 alone does not prove the actual route works.
  if vpn_guard_proxy_ready; then
    vpn_guard_note_success
    waiter_report "代理原位恢复成功（AUTO=$(vpn_mihomo_group_now AUTO)）；现有连接保持"
  else
    waiter_report "上游探测仍失败；保留代理监听，${VPN_GUARD_RECOVERY_COOLDOWN} 秒内不重复恢复"
  fi
}
