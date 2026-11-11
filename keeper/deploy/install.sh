#!/usr/bin/env bash
# Run from the Mac:  keeper/deploy/install.sh   (HOST=<your ssh host>). Idempotent. Does not enable the timer
# (that is a separate, explicit step after the simulate-only dry run). Touches only brimstead-keeper.* files.
set -euo pipefail
HOST=${HOST:?set HOST to your server ssh alias}
HERE=$(cd "$(dirname "$0")/.." && pwd)
KS=${KS:-$HOME/.foundry/keystores/brimstead-keeper}
rsync -a --delete --exclude node_modules --exclude data --exclude deploy --exclude .closetest.mjs \
  "$HERE/" "$HOST:/srv/brimstead-keeper/"
ssh "$HOST" 'set -e
  id brimstead-keeper >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin brimstead-keeper
  chown -R root:root /srv/brimstead-keeper && chmod -R go-w /srv/brimstead-keeper
  cd /srv/brimstead-keeper && npm ci --omit=dev --no-fund --no-audit --silent
  install -d -m 700 -o root -g root /etc/brimstead-keeper'
# keystore + password: encrypted JSON and its password, root-only 600 (never a raw key)
( umask 077; cat "$KS" | ssh "$HOST" 'umask 077; cat > /etc/brimstead-keeper/keystore.json' )
( umask 077; cat "$KS.password" | ssh "$HOST" 'umask 077; cat > /etc/brimstead-keeper/password' )
scp -q "$HERE/deploy/brimstead-keeper.service" "$HERE/deploy/brimstead-keeper.timer" "$HOST:/etc/systemd/system/"
ssh "$HOST" 'set -e
  test -f /etc/brimstead-keeper/keeper.env || printf "KEEPER_MODE=simulate\nRPC_URLS=https://rpc.mainnet.chain.robinhood.com,https://robinhood-rpc.publicnode.com\nKEEPER_MAX_FEE_GWEI=0.5\nKEEPER_LOW_BALANCE_ETH=0.0001\n" > /etc/brimstead-keeper/keeper.env
  chown root:root /etc/brimstead-keeper/* && chmod 600 /etc/brimstead-keeper/*
  systemctl daemon-reload
  ls -l /etc/brimstead-keeper'
echo "installed. dry run:  ssh $HOST systemctl start brimstead-keeper.service; journalctl -u brimstead-keeper -n 20"
echo "go live:  set KEEPER_MODE=live in /etc/brimstead-keeper/keeper.env, then systemctl enable --now brimstead-keeper.timer"
