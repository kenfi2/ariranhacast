#!/bin/bash
# Teste local: PeerServer + 1 anfitrião (vídeo sintético) + N participantes, tudo na mesma máquina.
# uso: scripts/test-local.sh [participantes=3] [maxdirect=1] [segundos=25]
# variáveis: HOSTX, V1X, V2X, V3X (argumentos extras por instância), TURN=1 (TURN local,
# anfitrião só via TURN), DROP=nome (mata a instância e espera DROPWAIT segundos)
N=${1:-3}; MAXD=${2:-1}; SECS=${3:-25}
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
npx peerjs --port 9000 --host 127.0.0.1 > "$TMP/server.log" 2>&1 &
PIDS=$!
if [ -n "$TURN" ]; then node scripts/turn-test.js > "$TMP/turn.log" 2>&1 & PIDS="$PIDS $!"; HOSTX="$HOSTX --lc-relayonly --lc-ice=[{\"urls\":\"turn:127.0.0.1:3478\",\"username\":\"teste\",\"credential\":\"teste\"}]"; fi
sleep 2
run() { # nome, args...
  local name=$1; shift
  xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --disable-gpu --use-fake-device-for-media-stream --use-fake-ui-for-media-stream \
    --lc-log --lc-server=127.0.0.1:9000 --lc-code=TEST01 --lc-profile="$TMP/$name" --lc-name="$name" "$@" \
    > "$TMP/$name.log" 2>&1 &
  PIDS="$PIDS $!"
}
run host --lc-auto=host --lc-maxdirect=$MAXD --lc-mic --lc-ns=standard --lc-cam $HOSTX
sleep 8
for i in $(seq 1 $N); do X="V${i}X"; run "v$i" --lc-auto=join --lc-mic --lc-ns=${NS:-ai} $([ $i = 1 ] && echo --lc-cam) ${!X}; sleep 3; done
sleep $SECS
if [ -n "$DROP" ]; then echo "derrubando $DROP"; pkill -f "lc-name=$DROP"; sleep ${DROPWAIT:-15}; fi
show() { # nome
  echo "== $1"
  for k in 'state' 'gate' 'gatepct' 'broadcast rows' 'watch stats' 'cams' 'voice' 'turn' 'room' 'act' 'watch end'; do grep -a "\[LC\] $k" "$TMP/$1.log" | tail -1; done
  grep -aiE 'Uncaught|TypeError|ReferenceError' "$TMP/$1.log" | head -3
}
show host; for i in $(seq 1 $N); do show "v$i"; done
echo "LOGDIR=$TMP"
pkill -f "lc-code=TEST01"; kill $PIDS 2>/dev/null; pkill -f "peerjs --port 900[0]"
