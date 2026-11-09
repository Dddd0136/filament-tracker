#!/bin/sh
# Keeps the printer clock correct (the board has no battery-backed RTC).
# Run once:  sudo sh ~/klipper_config/time_fix.sh
# 1) sets the time now from an HTTP Date header, 2) (re)starts chrony,
# 3) installs a boot-time fallback service that sets the time from HTTP after the network is up.

http_time() {
  curl -sI --max-time 10 http://google.com | grep -i '^date:' | cut -d' ' -f2- | tr -d '\r'
}

echo "== before: $(date)"
T="$(http_time)"
if [ -n "$T" ]; then date -s "$T" >/dev/null && echo "== set from HTTP: $(date)"; else echo "== no HTTP time (network?)"; fi
hwclock -w 2>/dev/null || true
fake-hwclock save 2>/dev/null || true

echo "== chrony:"
systemctl enable chrony >/dev/null 2>&1
systemctl restart chrony
sleep 8
systemctl is-active chrony
journalctl -u chrony -n 8 --no-pager 2>/dev/null | tail -8
chronyc tracking 2>&1 | grep -E 'Reference|System time|Leap' || true

cat > /usr/local/bin/http-time.sh <<'EOS'
#!/bin/sh
# wait up to ~2 min for the network, then set the clock from an HTTP Date header
i=0
while [ $i -lt 24 ]; do
  T="$(curl -sI --max-time 5 http://google.com | grep -i '^date:' | cut -d' ' -f2- | tr -d '\r')"
  if [ -n "$T" ]; then
    date -s "$T" >/dev/null
    fake-hwclock save 2>/dev/null || true
    systemctl restart chrony 2>/dev/null || true
    logger "http-time: clock set to $(date)"
    exit 0
  fi
  i=$((i+1)); sleep 5
done
logger "http-time: no network, clock not set"
EOS
chmod +x /usr/local/bin/http-time.sh

cat > /etc/systemd/system/http-time.service <<'EOS'
[Unit]
Description=Set clock from HTTP Date header at boot (no RTC on this board)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/http-time.sh

[Install]
WantedBy=multi-user.target
EOS
systemctl daemon-reload
systemctl enable http-time.service >/dev/null 2>&1 && echo "== boot fallback service: enabled"
echo "== after: $(date)"
