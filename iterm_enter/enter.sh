#!/bin/sh
# Send Enter to the first tab of each specified window, or the only window.
set -eu
/usr/bin/osascript - "$@" <<'APPLESCRIPT'
on run argv
if application "iTerm2" is not running then return
tell application "iTerm2"
    if (count of argv) > 0 then
        set targetIDs to argv
    else
        if (count of windows) is not 1 then return
        set targetIDs to {id of window 1}
    end if
    repeat with rawID in targetIDs
        set targetID to (rawID as text) as integer
        if (exists window id targetID) then
            tell window id targetID
                if (count of tabs) > 0 then
                    tell tab 1
                        select
                        tell current session to write text (ASCII character 13) newline false
                    end tell
                end if
            end tell
        end if
    end repeat
end tell
end run
APPLESCRIPT
