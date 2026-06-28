# Traffic Surge Monitor

Cloudflare Worker that watches methodictruth.com's existing analytics
(`analytics.js` → Firebase `analytics/events`) and emails an alert when
traffic spikes well above normal.

## How it decides "surge"

Every 10 minutes it compares:
- **Recent**: `session_start` events in the last 10 minutes
- **Baseline**: the average `session_start` count per 10-minute slice over
  the trailing hour (excluding the most recent 10 minutes)

It alerts when recent sessions are at least **3x** the baseline average
**and** at least **5** sessions (so quiet periods don't trigger on noise).
Alerts are throttled to once per hour even if the surge continues.

## Setup

### 1. Install Wrangler CLI (if not already)

```bash
npm install -g wrangler
wrangler login
```

### 2. Create the KV namespace (used to throttle repeat alerts)

```bash
cd traffic-monitor
wrangler kv namespace create traffic_monitor_kv
```

Copy the returned `id` into `wrangler.toml` under `[[kv_namespaces]]`.

### 3. Enable Email Routing on methodictruth.com

In the Cloudflare dashboard: **Email Routing** → enable it for the zone
(this adds the required DNS records automatically), then under
**Destination addresses**, add and verify `sergmacedo1@gmail.com` (a
confirmation link is emailed to it).

The `From` address (`alerts@methodictruth.com`) only needs to be on a
domain in this Cloudflare zone — it does not need its own mailbox.

### 4. Deploy

```bash
wrangler deploy
```

### 5. Test it manually

```bash
curl "https://traffic-monitor.<your-subdomain>.workers.dev/check?force=1"
```

`force=1` runs the check and sends a test email immediately (subject to
the same hourly cooldown), regardless of whether a real surge is
happening — useful to confirm email delivery works before waiting on
real traffic. Drop `?force=1` to just see the current stats as JSON
without sending anything unless a real surge is detected.

## Tuning

All thresholds are constants at the top of `traffic-monitor-worker.js`:
`RECENT_WINDOW_MS`, `BASELINE_WINDOW_MS`, `MIN_RECENT_SESSIONS`,
`SURGE_MULTIPLIER`, `ALERT_COOLDOWN_MS`.

## Cost

Cloudflare Workers Free Tier covers this easily — one scheduled
invocation every 10 minutes, well under the free request/CPU limits.
KV reads/writes and Email Routing sends are also free at this volume.
