# Uptime monitoring

Checks `api.methodictruth.com/health` every 15 minutes and emails on state
change. Runs on GitHub, **not** on the XPS — a monitor hosted on the machine it
watches cannot report that machine being down, which is the failure worth
hearing about.

`state.json` is the last observed state, committed so transitions are
detectable across runs. Its commit history doubles as an outage log.

## States

| | |
| --- | --- |
| `ok` | Reachable, `ok:true`, no subsystem complaining. |
| `degraded` | Answering, but something is broken — YouTube downloads failing, lyrics sidecar unreachable, ffmpeg missing. The site works; a feature does not. |
| `down` | Unreachable, non-200, timed out, or `ok:false`. Usually the box, cloudflared, or the house connection. |

One email when it breaks, one when it recovers. Not one per poll.

## Setup

Settings → Secrets and variables → Actions → **Secrets**:

| Secret | Value |
| --- | --- |
| `GMAIL_USER` | The sending Gmail address. |
| `GMAIL_APP_PASSWORD` | A **16-character App Password**, not the account password. Google Account → Security → 2-Step Verification → App passwords. Gmail SMTP rejects normal passwords. |
| `ALERT_EMAIL` | Where alerts go. Can be the same address. |

Optional **variable** `HEALTH_URL` overrides the endpoint.

Then Actions → **Uptime Alert** → Run workflow, to confirm it works without
waiting for the schedule.

## Things that will bite

**GitHub disables scheduled workflows after 60 days without repository
activity.** This repo is active, so it is unlikely — but if alerts go quiet for
a long stretch, check that the schedule is still enabled before trusting the
silence.

**Scheduled runs are best-effort.** GitHub delays them under load, so a 15
minute cron can mean 20. Fine for knowing a service died; not a substitute for
a paid uptime monitor if minutes matter.

**Silence is not proof.** If the workflow itself fails — expired app password,
Actions outage — no mail arrives, which looks identical to everything being
fine. Glance at the Actions tab occasionally.
