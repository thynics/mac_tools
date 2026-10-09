#!/bin/sh
# Control the persistent Enter loop without moving its LaunchAgent configuration.
set -eu

label=com.longcheng.iterm-enter
domain="gui/$(/usr/bin/id -u)"
service="$domain/$label"
plist="$HOME/Library/LaunchAgents/$label.plist"

usage() {
    printf '%s\n' 'Usage: iterm-resume [window ID ...] | iterm-pause | iterm-status' >&2
    printf '%s\n' 'Or: sh control.sh resume [window ID ...] | pause | status' >&2
    exit 1
}

case "${0##*/}" in
    iterm-resume) action=resume ;;
    iterm-pause) action=pause ;;
    iterm-status) action=status ;;
    *) action=${1:-}; if [ "$#" -gt 0 ]; then shift; fi ;;
esac

configured_targets() {
    index=2
    while target=$(/usr/libexec/PlistBuddy -c "Print :ProgramArguments:$index" "$plist" 2>/dev/null); do
        printf '%s ' "$target"
        index=$((index + 1))
    done
}

live_targets() {
    /usr/bin/osascript <<'APPLESCRIPT'
if application "iTerm2" is not running then return ""
tell application "iTerm2"
    set windowIDs to ""
    repeat with targetWindow in windows
        set windowIDs to windowIDs & (id of targetWindow as text) & " "
    end repeat
    return windowIDs
end tell
APPLESCRIPT
}

show_targets() {
    [ -f "$plist" ] || return 0
    targets=$(configured_targets)
    printf 'Target windows: %s\n' "${targets:-the only iTerm window}"
    [ -n "$targets" ] || return 0
    if ! live=$(live_targets); then
        printf '%s\n' 'Unable to check iTerm windows.' >&2
        return 0
    fi
    for target in $targets; do
        case " $live " in
            *" $target "*) ;;
            *) printf 'Window %s is unavailable; it will be skipped. Use iterm-resume with new window IDs to change targets.\n' "$target" >&2 ;;
        esac
    done
}

case "$action" in
    pause)
        [ "$#" -eq 0 ] || usage
        /bin/launchctl disable "$service"
        if /bin/launchctl print "$service" >/dev/null 2>&1; then
            /bin/launchctl bootout "$service"
        fi
        printf '%s\n' 'iTerm Enter paused (including future logins).'
        ;;
    resume)
        if [ ! -f "$plist" ]; then
            printf 'Missing LaunchAgent configuration: %s\n' "$plist" >&2
            exit 1
        fi
        /usr/bin/plutil -lint -s "$plist"
        if [ "$#" -gt 0 ]; then
            # Validate all targets before changing either the file or the service.
            for target in "$@"; do
                case "$target" in
                    ''|*[!0-9]*) printf 'Invalid window ID: %s\n' "$target" >&2; exit 1 ;;
                esac
            done
            live=$(live_targets)
            for target in "$@"; do
                case " $live " in
                    *" $target "*) ;;
                    *) printf 'iTerm window %s does not exist; configuration was not changed.\n' "$target" >&2; exit 1 ;;
                esac
            done
            requested=$(printf '%s ' "$@")
            if [ "$requested" != "$(configured_targets)" ]; then
                temporary=$(/usr/bin/mktemp "${plist}.XXXXXX")
                trap 'rm -f "$temporary"' 0
                trap 'exit 1' HUP INT TERM
                /bin/cp -p "$plist" "$temporary"
                while /usr/libexec/PlistBuddy -c 'Print :ProgramArguments:2' "$temporary" >/dev/null 2>&1; do
                    /usr/libexec/PlistBuddy -c 'Delete :ProgramArguments:2' "$temporary"
                done
                for target in "$@"; do
                    /usr/libexec/PlistBuddy -c "Add :ProgramArguments: string $target" "$temporary"
                done
                /usr/bin/plutil -lint -s "$temporary"
                /bin/mv "$temporary" "$plist"
                if /bin/launchctl print "$service" >/dev/null 2>&1; then
                    /bin/launchctl bootout "$service"
                fi
            fi
        fi
        /bin/launchctl enable "$service"
        if /bin/launchctl print "$service" >/dev/null 2>&1; then
            /bin/launchctl kickstart "$service"
        else
            /bin/launchctl bootstrap "$domain" "$plist"
        fi
        printf '%s\n' 'iTerm Enter resumed (one second between runs).'
        show_targets
        ;;
    status)
        [ "$#" -eq 0 ] || usage
        if job=$(/bin/launchctl print "$service" 2>/dev/null); then
            printf '%s\n' "$job" | /usr/bin/awk '$1 == "state" && $2 == "=" && !state_seen { print "State: " $3; state_seen = 1 } $1 == "pid" && $2 == "=" { print "PID: " $3 }'
        else
            printf '%s\n' 'State: stopped'
        fi
        show_targets
        ;;
    *) usage ;;
esac
