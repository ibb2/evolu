#!/usr/bin/env bash
curl -f https://get.pnpm.io/v6.16.js | node - add --global pnpm
pnpm install
pnpm run build
