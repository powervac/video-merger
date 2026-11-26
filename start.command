#!/bin/sh
cd "$(dirname "$0")" || exit 1
command -v npm >/dev/null 2>&1 || { echo "Node.js не найден. Установите его с https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install
npm start
