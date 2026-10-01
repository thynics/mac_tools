#!/bin/sh
# Send Enter to the first tab of a specified window, or the only window.
set -eu
/usr/bin/osascript - "$@" <<'APPLESCRIPT'
on run argv
if application "iTerm2" is not running then return
tell application "iTerm2"
    if (count of argv) > 0 then
        set targetID to (item 1 of argv) as integer
        if not (exists window id targetID) then return
        set targetWindow to window id targetID
    else
        if (count of windows) is not 1 then return
        set targetWindow to window 1
    end if
    tell targetWindow
        if (count of tabs) is 0 then return
        tell tab 1
            select
            tell current session to write text (ASCII character 13) newline false
        end tell
    end tell
end tell
end run
APPLESCRIPT
