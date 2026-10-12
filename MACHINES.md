# Machines

What each box is, what it runs, and what is special about it. Written because
the estate reached four machines and lived only in one person's head.

Local addresses are RFC1918 — meaningful inside the house and nowhere else.
**No credentials, keys, MAC addresses or public IPs belong in this file.**

Network: ASUS RT-AX1800S V2 · subnet `192.168.4.x`

---

## `chord` — Dell OptiPlex 3000 Micro

The analyzer's CPU half. Everything the Song Analyzer does except transcription.

| | |
| --- | --- |
| Model | OptiPlex 3000 Micro (Reg. D15U, type D15U002) |
| CPU | Intel Core i5, 12th gen — 6C/12T, 35 W |
| GPU | Intel UHD (Quick Sync — hardware ffmpeg decode) |
| RAM | 32 GB DDR4-3200 SO-DIMM (2×16 GB, dual channel; 64 GB max) |
| Disk | 256 GB NVMe, PCIe Gen4 ×4, M.2 2230 |
| OS | Ubuntu Server 24.04.5 LTS · Python 3.12.3 |
| User | `chord` |
| Address | `192.168.4.116` |

**Runs:** `app.py` under gunicorn, yt-dlp, ffmpeg, cloudflared, and the PO-token
server. See `chord-server/SPLIT-HOSTS.md`.

**Why this box:** `app.py` has no torch and no CUDA — download, decode, librosa
analysis, chord decoding and pitch renders are all CPU. Quick Sync does the
ffmpeg passes in hardware. Six cores with nothing else competing is what lets
`ANALYSIS_SLOTS` go from 1 to 3.

**Watch:** the disk. The analyzer caches mp3s and prunes LRU; 256 GB is the real
constraint and a 1 TB M.2 2230 is the cheap fix. SATA mode is **AHCI** — do not
change it after install or it will not boot.

**Set at install:** sleep/suspend/hibernate targets masked. The root LV was
expanded from the installer's 100 GB default to the full 232 GB (see below).

---

## `amp` — Dell XPS laptop

Spare capacity. Role not finally settled; the candidates are Demucs stem
separation and a backup target.

| | |
| --- | --- |
| CPU | Intel Core i7-11800H — 8C/16T, 11th gen |
| GPU | NVIDIA GeForce RTX 3050 Ti Laptop — **4 GB VRAM** · Intel UHD iGPU |
| RAM | 32 GB |
| Disk | NVMe |
| Network | Intel Tiger Lake CNVi Wi-Fi · Realtek RTL8153 USB gigabit (via dock) |
| OS | Ubuntu Server 24.04.5 LTS |
| User | `amp` |
| Address | `192.168.4.165` |

**The 4 GB is the deciding fact.** It is *less* VRAM than the 8930's 6 GB card,
so this does not replace the GPU host: the lyrics service keeps a ~3 GB model
resident and that is already tight at 6 GB. Whisper stays on the 8930.

**What 4 GB is fine for:** Demucs, because stem separation is batch work. Reduce
the segment size to fit the card and let it run overnight — a song is separated
once, cached, and every later analysis benefits. A card too small for
interactive transcription is adequate for a queue.

**Laptop caveats:** it throttles under sustained load (45 W part, thin chassis),
and it needs `HandleLidSwitch=ignore` in `/etc/systemd/logind.conf` or it
suspends when closed. Cap the battery charge in BIOS if the option exists —
permanent AC at 100% kills a laptop battery in about a year.

---

## XPS 8930 — the GPU host

| | |
| --- | --- |
| GPU | NVIDIA, 6 GB |
| OS | Ubuntu |
| Hostname | `dkcommunisst` (also its Meshnet name) |

**Runs:** `lyrics_service.py` — faster-whisper `large-v3` on CUDA,
`int8_float16`, one gunicorn worker. One worker is deliberate: it keeps a single
~3 GB model resident on a 6 GB card and serialises GPU access without a lock.

**History worth remembering:** a 2 TB SATA drive fell off the bus mid-session
(`ata2.00: disable device`) and the stale `/etc/fstab` entry then hung every
boot. Nothing was lost — the OS, venvs and Whisper models are all on the NVMe.
The lesson stuck: **nothing goes in `fstab` that might not be present.**

---

## Kamrui — the agent box

| | |
| --- | --- |
| CPU | Intel N100 |
| RAM | 8 GB |
| OS | Windows + WSL2 (Ubuntu) |

**Runs:** OpenClaw, the agent that works on this site.

**Outstanding, before this box is ever repurposed:** destroy `~/.cloudflared/`
(the credentials are the authority for `api.methodictruth.com`) and
`cookies.txt` (live Google credentials, gitignored, never to be committed).

---

## Mac mini — the studio

Apple silicon. Logic Pro, the Clarett and everything in `STUDIO.md`. Not part of
the web estate; listed because it holds the studio work, and because of what
happened to it.

**Status: locked out since October 2026.** It stopped booting and now lands on
*Activate Mac* on every restart. `Macintosh HD` is still visible in the startup
picker, so the disk is alive and this is a boot fault rather than a destroyed
install — but on Apple silicon, Recovery requires authenticating as a volume
owner before it hands over Terminal or Disk Utility, so none of the usual
diagnostics are reachable. Activation Lock is held by the owner's own Apple ID,
which means the machine itself is recoverable. The data is a separate question:
no FileVault recovery key was ever saved, and Apple keeps no copy. The
non-destructive escalation is a **Revive** (Apple Configurator 2 from a second
Mac over USB-C), *not* a Restore, which erases. See `MAC-REBUILD.md`.

**The thing this file used to say** — that Logic projects and tape captures
exist in exactly one place — turned out to be wrong, and that is the only reason
this was survivable. A large part of the catalogue is in Google Drive: whole
`.logicx` packages (visible there as folders containing Logic's own
`Project File Backups`), stems, bounces and plugin presets, weighted towards
late 2023 and January 2025. It was an accident of ad-hoc uploads rather than a
backup policy. Fix that rather than relying on it twice.

---

## Conventions

**Hostnames are functional**, not personal — at this scale you remember what a
box does long before you remember what it was called. `chord` matches
`chord-server/`, `chord-analyzer.service` and `chord-analyzer.log`, so the name
is already in the config files you read.

**SSH keys come from GitHub.** `ssh-import-id gh:colimaforever` at install time
puts the key in `authorized_keys` before the machine is ever headless — which is
the step whose absence once stranded the 8930. The private half never leaves the
machine you sit at; every server gets a copy of the public half.

**Password auth stays on** until key auth is proven from a second machine.
Turning it off first is how you lock yourself out of a box with no monitor.

**The Ubuntu Server installer only allocates ~100 GB** of the disk to the root
logical volume and leaves the rest unclaimed in the volume group. Both machines
here needed:

```bash
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
sudo resize2fs /dev/ubuntu-vg/ubuntu-lv
```

**Nothing here depends on the router.** The Cloudflare Tunnel is an outbound
connection — no port forwards, no inbound rules, no dynamic DNS — so the public
site survives a router swap untouched. What does not survive is hardcoded IPs:
prefer `<host>.local` over an address wherever something points at another
machine.
