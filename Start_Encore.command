#!/bin/bash
# Starts the Encore server and opens the admin app. launch.py locates a suitable Python 3.11+ itself.
cd -- "$(dirname -- "$0")" || exit 1
python="${ENCORE_PYTHON:-python3}"
command -v "$python" >/dev/null 2>&1 || python=/usr/bin/python3
"$python" launch.py
if [ "$?" -ne 0 ]; then
  read -r -p "Press Return to close. "
fi
