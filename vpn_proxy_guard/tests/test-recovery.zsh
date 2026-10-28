#!/bin/zsh
# Mock regression tests: never contact the controller or restart a service.
set -eu

typeset -gr TEST_SOURCE_DIR="${0:A:h:h}"
typeset -gi TEST_PASSED=0

fail() { print -ru2 -- "FAIL: $*"; exit 1; }
assert_equal() { [[ "$1" == "$2" ]] || fail "$3: expected <$2>, got <$1>"; }

setup_guard() {
  source "${TEST_SOURCE_DIR}/proxy-recovery.zsh"
  typeset -ga TEST_EVENTS=()
  typeset -gi TEST_PROBE_READY=0 TEST_CONTROLLER_FAIL=0 TEST_RESTARTS=0
  vpn_log() { :; }
  vpn_warn() { :; }
  waiter_report() { :; }
  vpn_mihomo_group_now() { print -r -- KIX; }
  vpn_restart_mihomo() { (( TEST_RESTARTS += 1 )); }
  vpn_guard_controller_request() {
    TEST_EVENTS+=("controller|$1|$2|$3")
    (( TEST_CONTROLLER_FAIL == 0 ))
  }
  vpn_guard_proxy_ready() {
    TEST_EVENTS+=(probe)
    (( TEST_PROBE_READY == 1 ))
  }
}

test_threshold_and_order() (
  setup_guard
  vpn_guard_handle_probe_failure
  assert_equal "$VPN_GUARD_FAILURES" 1 'first failure counted'
  assert_equal "${#TEST_EVENTS}" 0 'first failure must not recover'
  vpn_guard_handle_probe_failure
  assert_equal "${#TEST_EVENTS}" 0 'second failure must not recover'
  TEST_PROBE_READY=1
  vpn_guard_handle_probe_failure
  assert_equal "${#TEST_EVENTS}" 4 'third failure performs three requests and business probe'
  assert_equal "$TEST_EVENTS[1]" 'controller|POST|/cache/dns/flush|3' 'DNS cache first'
  assert_equal "$TEST_EVENTS[2]" 'controller|GET|/group/KIX/delay?url=https%3A%2F%2Fapi.openai.com%2Fv1%2Fmodels&timeout=5000&expected=401|12' 'KIX requires the API authentication response, excluding region/proxy errors'
  assert_equal "$TEST_EVENTS[3]" 'controller|GET|/group/AUTO/delay?url=https%3A%2F%2Fwww.apple.com%2Flibrary%2Ftest%2Fsuccess.html&timeout=5000&expected=200|12' 'AUTO follows KIX with its original URL'
  assert_equal "$TEST_EVENTS[4]" probe 'final business probe required'
  assert_equal "$VPN_GUARD_FAILURES" 0 'business success clears failures'
  assert_equal "$TEST_RESTARTS" 0 'recovery never restarts service'
)

test_cooldown_survives_success() (
  setup_guard
  repeat 3; do vpn_guard_handle_probe_failure; done
  assert_equal "${#TEST_EVENTS}" 4 'initial recovery happened'
  local previous_recovery="$VPN_GUARD_LAST_RECOVERY"
  vpn_guard_note_success
  assert_equal "$VPN_GUARD_LAST_RECOVERY" "$previous_recovery" 'one success preserves cooldown'
  repeat 5; do vpn_guard_handle_probe_failure; done
  assert_equal "${#TEST_EVENTS}" 4 'failures during cooldown do not call controller or business probe again'
  VPN_GUARD_LAST_RECOVERY=$(( SECONDS - VPN_GUARD_RECOVERY_COOLDOWN - 1 ))
  vpn_guard_handle_probe_failure
  assert_equal "${#TEST_EVENTS}" 8 'recovery is permitted after cooldown'
  assert_equal "$TEST_RESTARTS" 0 'persistent failure never restarts service'
)

test_controller_and_probe_failure() (
  setup_guard
  TEST_CONTROLLER_FAIL=1
  repeat 3; do vpn_guard_handle_probe_failure; done
  assert_equal "${#TEST_EVENTS}" 4 'controller failure still attempts remaining requests and business probe'
  assert_equal "$TEST_EVENTS[4]" probe 'controller HTTP result does not replace business probe'
  assert_equal "$VPN_GUARD_FAILURES" 3 'business failure does not clear failure count'
  assert_equal "$TEST_RESTARTS" 0 'controller failure never restarts service'
  local previous_recovery="$VPN_GUARD_LAST_RECOVERY"
  vpn_guard_handle_probe_failure
  assert_equal "$VPN_GUARD_LAST_RECOVERY" "$previous_recovery" 'failed recovery also observes cooldown'
  assert_equal "${#TEST_EVENTS}" 4 'failed recovery is not repeated immediately'
)

test_success_resets_consecutive_failures() (
  setup_guard
  repeat 2; do vpn_guard_handle_probe_failure; done
  vpn_guard_note_success
  repeat 2; do vpn_guard_handle_probe_failure; done
  assert_equal "${#TEST_EVENTS}" 0 'intervening success resets consecutive failure threshold'
)

# Execute a copy of the actual watcher with its library, controller/DNS
# transport and sleeps mocked. File-backed counters also work in $(...) calls.
run_watcher_fixture() {
  local scenario="$1" fixture
  fixture=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/vpn-guard-test.XXXXXX")
  /bin/cp "${TEST_SOURCE_DIR}/proxy-recovery.zsh" "$fixture/proxy-recovery.zsh"
  /usr/bin/sed 's@/bin/sleep @vpn_test_sleep @g' \
    "${TEST_SOURCE_DIR}/wait-for-globalprotect.zsh" > "$fixture/wait-for-globalprotect.zsh"
  cat > "$fixture/lib-vpn-setting.zsh" <<'MOCK'
test_record() { print -r -- "$*" >> "$TEST_EVENT_FILE"; }
vpn_prepare_runtime_dirs() { return 0; }
vpn_read_mode() { print -r -- company; }
vpn_detect_network_service() { print -r -- Wi-Fi; }
vpn_dns_signature() {
  if [[ "$TEST_SCENARIO" == dns-change* && -e "$TEST_DNS_SEEN" ]]; then
    print -r -- corporate-dns
  else
    : > "$TEST_DNS_SEEN"
    print -r -- initial-dns
  fi
}
vpn_mihomo_listening() {
  [[ "$TEST_SCENARIO" != *dead-listener || -e "$TEST_LISTENER_RESTORED" ]]
}
vpn_restart_mihomo() {
  test_record restart
  : > "$TEST_LISTENER_RESTORED"
}
vpn_wait_for_mihomo_listening() { test_record listener-check; }
vpn_company_system_proxy_matches() { return 0; }
vpn_effective_company_proxy_compatible() { return 0; }
vpn_company_env_matches() { return 0; }

vpn_mihomo_group_now() { print -r -- KIX; }
vpn_log() { :; }
vpn_warn() { :; }
vpn_test_sleep() {
  (( TEST_SLEEP_COUNT += 1 ))
  (( TEST_SLEEP_COUNT < TEST_SLEEP_LIMIT )) || exit 0
}
typeset -gi TEST_SLEEP_COUNT=0 TEST_DNS_REFRESH_COUNT=0
MOCK
  # These definitions are appended to the copied companion because it is
  # sourced after the fixture library. No production transport can execute.
  cat >> "$fixture/proxy-recovery.zsh" <<'MOCK'
vpn_guard_proxy_ready() {
  test_record probe
  [[ "$TEST_SCENARIO" == healthy || "$TEST_SCENARIO" == *dns* ]]
}
vpn_guard_controller_request() {
  test_record "controller:$1:$2"
  [[ "$TEST_SCENARIO" != controller-failure ]]
}
vpn_guard_refresh_proxy_dns() {
  (( TEST_DNS_REFRESH_COUNT += 1 ))
  test_record "dns:$1"
  # A controller cannot reload while the listener/service is down.
  vpn_mihomo_listening || return 1
  if [[ "$TEST_SCENARIO" == startup-dns-retry ]] && (( TEST_DNS_REFRESH_COUNT == 1 )); then
    return 1
  fi
  if [[ "$TEST_SCENARIO" == dns-change-retry ]] && (( TEST_DNS_REFRESH_COUNT == 2 )); then
    return 1
  fi
  return 0
}
MOCK
  local event_file="$fixture/events"
  : > "$event_file"
  local sleep_limit=1
  [[ "$scenario" == probe-failure || "$scenario" == controller-failure ]] && sleep_limit=4
  [[ "$scenario" == startup-dns-retry || "$scenario" == dns-change-retry ||
     "$scenario" == *dead-listener ]] && sleep_limit=4
  if ! TEST_SCENARIO="$scenario" TEST_EVENT_FILE="$event_file" \
      TEST_DNS_SEEN="$fixture/dns-seen" TEST_SLEEP_LIMIT="$sleep_limit" \
      TEST_LISTENER_RESTORED="$fixture/listener-restored" \
      /bin/zsh "$fixture/wait-for-globalprotect.zsh"; then
    /bin/rm -rf "$fixture"
    fail "watcher fixture $scenario exited unsuccessfully"
  fi
  local events="$(<"$event_file")"
  /bin/rm -rf "$fixture"
  local -a event_lines=("${(@f)events}")
  local event dns_initial=0 dns_changed=0 restarts=0 probes=0 listener_checks=0
  for event in "${event_lines[@]}"; do
    case "$event" in
      dns:initial-dns) (( dns_initial += 1 )) ;;
      dns:corporate-dns) (( dns_changed += 1 )) ;;
      restart) (( restarts += 1 )) ;;
      probe) (( probes += 1 )) ;;
      listener-check) (( listener_checks += 1 )) ;;
    esac
  done
  (( dns_initial >= 1 )) || fail "$scenario must refresh DNS on startup"
  case "$scenario" in
    *dead-listener)
      assert_equal "$restarts" 1 "$scenario restores the missing listener once"
      assert_equal "$listener_checks" 1 "$scenario checks the restored listener"
      if [[ "$scenario" == dns-change-dead-listener ]]; then
        (( dns_changed >= 1 )) || fail 'changed DNS must still be applied after the listener recovers'
        (( probes >= 1 )) || fail 'DNS change must not trap a stopped service in reload retries'
      fi
      ;;
    dns-change)
      assert_equal "$dns_changed" 1 'DNS transition triggers a hot reload'
      assert_equal "$restarts" 0 'DNS transition preserves the listener'
      ;;
    dns-change-retry)
      assert_equal "$dns_changed" 2 'failed DNS transition is retried, then stops after success'
      assert_equal "$restarts" 0 'failed DNS reload must not restart a listening service'
      (( probes >= 1 )) || fail 'watcher resumes probes after DNS reload succeeds'
      ;;
    startup-dns-retry)
      assert_equal "$dns_initial" 2 'failed startup DNS reload is retried without another DNS transition'
      assert_equal "$restarts" 0 'failed startup DNS reload must not restart a listening service'
      (( probes >= 1 )) || fail 'watcher resumes probes after startup DNS reload succeeds'
      ;;
    healthy)
      assert_equal "$events" $'dns:initial-dns\nprobe' 'startup refreshes DNS and leaves healthy listener alone'
      ;;
    probe-failure|controller-failure)
      [[ "$events" != *restart* ]] || fail "$scenario must never restart"
      assert_equal "${#event_lines}" 9 "$scenario has startup DNS, four watcher probes, one business recheck, three controller calls"
      assert_equal "$event_lines[5]" 'controller:POST:/cache/dns/flush' "$scenario recovers on third watcher probe"
      assert_equal "$event_lines[8]" probe "$scenario performs final business recheck"
      ;;
  esac
}

run_case() {
  "$@"
  (( TEST_PASSED += 1 ))
  print -r -- "PASS: $*"
}

run_case test_threshold_and_order
run_case test_cooldown_survives_success
run_case test_controller_and_probe_failure
run_case test_success_resets_consecutive_failures
run_case run_watcher_fixture healthy
run_case run_watcher_fixture probe-failure
run_case run_watcher_fixture controller-failure
run_case run_watcher_fixture dead-listener
run_case run_watcher_fixture dns-change
run_case run_watcher_fixture startup-dns-retry
run_case run_watcher_fixture dns-change-retry
run_case run_watcher_fixture dns-change-dead-listener
print -r -- "All ${TEST_PASSED} mock regression cases passed."
