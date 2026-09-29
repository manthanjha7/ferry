#!/bin/sh
# Render the brand sources in src/ to PNGs beside this file.
#   sh render.sh            all
#   sh render.sh cover      one
set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
shot() { # name width height out [transparent]
  bg=""; [ -n "$5" ] && bg="--default-background-color=00000000"
  "$CHROME" --headless --hide-scrollbars --force-device-scale-factor=1 $bg --virtual-time-budget=6000 \
    --window-size="$2,$3" --screenshot="$PWD/$4" "file://$PWD/src/$1.html" 2>/dev/null
  echo "$4"
}
want() { [ -z "$1" ] || [ "$1" = "$2" ]; }
want "$1" icon && shot icon 128 128 icon.png transparent
want "$1" cover && shot cover 1920 1080 cover.png
want "$1" tokens && shot tokens 1920 1080 carousel-1-tokens.png
want "$1" components && shot components 1920 1080 carousel-2-components.png
want "$1" link && shot link 1920 1080 carousel-3-link.png
true
