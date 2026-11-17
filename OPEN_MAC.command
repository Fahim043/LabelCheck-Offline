#!/bin/zsh
cd -- "$(dirname -- "$0")"
if [ -d "/Applications/Google Chrome.app" ]; then
  open -a "Google Chrome" "$PWD/index.html"
elif [ -d "/Applications/Microsoft Edge.app" ]; then
  open -a "Microsoft Edge" "$PWD/index.html"
else
  echo "Install Google Chrome or Microsoft Edge, then open index.html in that browser."
  read "?Press Enter to close..."
fi
