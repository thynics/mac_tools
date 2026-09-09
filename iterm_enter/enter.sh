#!/bin/sh
# Send one Enter to the active pane in the first tab of iTerm's only window.
set -eu
/usr/bin/osascript <<'APPLESCRIPT'
if application "iTerm2" is not running then return
tell application "iTerm2"
    if (count of windows) is not 1 then return
    tell window 1
        if (count of tabs) is 0 then return
        tell tab 1
            select
            tell current session to write text (ASCII character 13) newline false
        end tell
    end tell
end tell
APPLESCRIPT
