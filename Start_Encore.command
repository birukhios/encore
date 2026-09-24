#!/bin/bash
# Starts Encore and opens the organizer admin. Needs Node.js 20+ and the .NET 8 SDK.
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v npm >/dev/null 2>&1 || ! command -v dotnet >/dev/null 2>&1; then
  echo "Encore needs Node.js (https://nodejs.org) and the .NET 8 SDK (brew install --cask dotnet-sdk@8)."
  read -r -p "Press Return to close. "
  exit 1
fi
[ -d node_modules ] || npm ci
[ -f dist/admin.html ] || npm run build
npm start
if [ "$?" -ne 0 ]; then
  read -r -p "Press Return to close. "
fi
