#!/bin/zsh
set -eu
umask 077

typeset -r GUARD_SOURCE_DIR="${0:A:h}"
(( $# == 0 )) || { print -ru2 -- "Usage: zsh install.zsh"; exit 1; }
typeset -r GUARD_TARGET_DIR="${HOME}/vpn_setting"
typeset -r GUARD_BACKUP_DIR="${GUARD_TARGET_DIR}/install-backups/$(/bin/date '+%Y%m%d-%H%M%S')-proxy-guard-$$"

[[ -r "${GUARD_TARGET_DIR}/lib-vpn-setting.zsh" &&
   -r "${GUARD_TARGET_DIR}/wait-for-globalprotect.zsh" ]] || {
  print -ru2 -- "An existing ChinaProxy installation is required: ${GUARD_TARGET_DIR}"
  exit 1
}

for guard_file in proxy-recovery.zsh wait-for-globalprotect.zsh; do
  /bin/zsh -n "${GUARD_SOURCE_DIR}/${guard_file}"
done

/bin/mkdir -p "$GUARD_BACKUP_DIR"
# Keep the installed template consistent too: a later company/private mode
# switch copies it back to Mihomo's active configuration.
typeset -r GUARD_TEMPLATE="${GUARD_TARGET_DIR}/mihomo-config.yaml"
typeset -r GUARD_CANDIDATE="${GUARD_BACKUP_DIR}/template-candidate.yaml"
/usr/bin/python3 "${GUARD_SOURCE_DIR}/proxy-dns.py" "$GUARD_TEMPLATE" "" \
  --stabilize-routing --output "$GUARD_CANDIDATE"
typeset -r GUARD_MIHOMO="$(command -v mihomo)"
"$GUARD_MIHOMO" -t -d "$GUARD_BACKUP_DIR" -f "$GUARD_CANDIDATE"
/bin/cp -p "$GUARD_TEMPLATE" "${GUARD_BACKUP_DIR}/mihomo-config.yaml"
for guard_file in proxy-dns.py proxy-recovery.zsh wait-for-globalprotect.zsh; do
  if [[ -e "${GUARD_TARGET_DIR}/${guard_file}" ]]; then
    /bin/cp -p "${GUARD_TARGET_DIR}/${guard_file}" "${GUARD_BACKUP_DIR}/${guard_file}"
  fi
  /usr/bin/install -m 700 "${GUARD_SOURCE_DIR}/${guard_file}" "${GUARD_TARGET_DIR}/${guard_file}.new"
  /bin/mv -f "${GUARD_TARGET_DIR}/${guard_file}.new" "${GUARD_TARGET_DIR}/${guard_file}"
done
/usr/bin/install -m 600 "$GUARD_CANDIDATE" "${GUARD_TEMPLATE}.new"
/bin/mv -f "${GUARD_TEMPLATE}.new" "$GUARD_TEMPLATE"
/bin/rm -f "$GUARD_CANDIDATE"

typeset -r GUARD_AGENT="gui/$(/usr/bin/id -u)/com.nvidia.chinaproxy.bootstrap"
if /bin/launchctl print "$GUARD_AGENT" >/dev/null 2>&1; then
  /bin/launchctl kickstart -k "$GUARD_AGENT"
  print -r -- "Installed and restarted the watchdog; Mihomo was left running."
else
  print -r -- "Installed. The watchdog is not loaded; it will use this version on its next launch."
fi
print -r -- "Backup: ${GUARD_BACKUP_DIR}"
