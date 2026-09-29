#!/bin/sh
# Who is using the site — a summary of the gunicorn access log.
#
# Reads CF-Connecting-IP rather than the socket address: every request arrives
# through the Cloudflare tunnel, so the connecting address is always 127.0.0.1.
#
# Usage:  ./who.sh [hours]        (default 24)
set -eu

LOG="${LOG:-$(dirname "$0")/chord-analyzer.log}"
HOURS="${1:-24}"

[ -f "$LOG" ] || { echo "no log at $LOG"; exit 1; }

SINCE=$(date -u -d "$HOURS hours ago" +%s 2>/dev/null || date -u -v-"${HOURS}"H +%s)

# gunicorn stamps [dd/Mon/yyyy:HH:MM:SS +0000]; filter to the window, then count.
awk -v since="$SINCE" '
  /ip=/ {
    if (match($0, /\[[^]]+\]/)) {
      ts = substr($0, RSTART+1, RLENGTH-2)
      gsub(/[:\/]/, " ", ts)
      cmd = "date -u -d \"" ts "\" +%s 2>/dev/null"
      cmd | getline epoch; close(cmd)
      if (epoch == "" || epoch+0 >= since) print
    } else print
  }' "$LOG" > /tmp/.who.$$ 2>/dev/null || cp "$LOG" /tmp/.who.$$

TOTAL=$(wc -l < /tmp/.who.$$)
echo "=== last ${HOURS}h: ${TOTAL} requests ==="
echo

echo "--- visitors (distinct IPs) ---"
grep -o 'ip=[^ ]*' /tmp/.who.$$ | sort -u | grep -vc 'ip=-' || true
echo

echo "--- top paths ---"
grep -o '"[A-Z][A-Z]* /[^"]*"' /tmp/.who.$$ | sed 's/"//g' | awk '{print $1, $2}' \
  | sort | uniq -c | sort -rn | head -12
echo

echo "--- countries ---"
grep -o 'cc=[^ ]*' /tmp/.who.$$ | sort | uniq -c | sort -rn | head -10
echo

echo "--- busiest visitors ---"
grep -o 'ip=[^ ]*' /tmp/.who.$$ | sort | uniq -c | sort -rn | head -8
echo

echo "--- slowest requests ---"
grep -o '"[A-Z][A-Z]* /[^"]*" [0-9]* [0-9]*b [0-9]*ms' /tmp/.who.$$ \
  | awk '{ms=$NF; gsub(/ms/,"",ms); print ms, $0}' | sort -rn | head -6 \
  | awk '{$1=""; print}'
echo

echo "--- errors ---"
awk '{for(i=1;i<=NF;i++) if ($i ~ /^[45][0-9][0-9]$/) {print $i; break}}' /tmp/.who.$$ \
  | sort | uniq -c | sort -rn | head -5
echo "(nothing above = no 4xx/5xx)"

rm -f /tmp/.who.$$
