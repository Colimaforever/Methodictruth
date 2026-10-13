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
| Address | `192.168.4.116` · Meshnet `100.80.35.26` |

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

**The stems host.** Runs `stems_service.py` — Demucs separation plus per-part
note transcription, feeding the analyzer's Full MIDI export. See
`chord-server/STEMS.md`.

| | |
| --- | --- |
| CPU | Intel Core i7-11800H — 8C/16T, 11th gen |
| GPU | NVIDIA GeForce RTX 3050 Ti Laptop — **4 GB VRAM** · Intel UHD iGPU |
| RAM | 32 GB |
| Disk | NVMe |
| Network | Intel Tiger Lake CNVi Wi-Fi · Realtek RTL8153 USB gigabit (via dock) |
| OS | Ubuntu Server 24.04.5 LTS |
| User | `amp` |
| Address | `192.168.4.165` · Meshnet `100.93.117.163` |

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
| User | `methodictruth` |
| Hostname | `methodictruth-XPS-8930` |
| Address | `192.168.4.50` |
| Meshnet | nickname `SongAnalyzer` · `sergmacedo1-sierranevada.nord` |

**It is not `dkcommunisst`.** That name was recorded here and in the SSH config
for months and is wrong. `DKCommunisst` is the **Windows gaming PC** — a
different machine entirely, on the same Meshnet as `sergmacedo1-altai.nord`.
This box was named `methodictruth` at install.

The cost of the mix-up: anything pointed at `dkcommunisst.nord` was aimed at a
Windows host with no sshd, which is exactly the "connection timed out" once
blamed on *this* machine failing to boot. A wrong name produced a wrong
diagnosis, and the diagnosis stuck longer than the name did.

Use the LAN address for anything in this house. Meshnet is the right answer from
outside it and the wrong one for a hop between two machines in the same room —
it routes a local request out through Nord and back.

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

| | |
| --- | --- |
| Model | Mac mini, Apple silicon (M-series) |
| OS | macOS, reinstalled 12 October 2026 |
| User | `deposibilidad` (full name `dePosibilidad`) |
| Role | Workstation. Logic, and the machine that administers the servers |

### What happened, October 2026

It stopped booting and landed on *Activate Mac* on every restart. `Macintosh HD`
was still visible in the startup picker, so the disk was alive and it was a boot
fault rather than a destroyed install — but on Apple silicon, Recovery makes you
authenticate as a **volume owner** before it hands over Terminal or Disk Utility,
and the account password was refused there. No reset link appeared, because the
reset link needs an account record it could reach.

The non-destructive escalation was a **Revive** — Apple Configurator 2 from a
second Mac over USB-C, which reinstalls firmware and recoveryOS and leaves the
data volume alone. *Restore*, the button beside it, erases. The Revive was never
tried; the disk was erased instead.

**What that cost:** everything after January 2025. On Apple silicon an erase
destroys the volume keys in the Secure Enclave — there is no undelete and no
forensic recovery, and no data recovery company can help. No FileVault recovery
key had ever been saved, and Apple keeps no copy of one.

**What saved the rest:** `DRIVE-ARCHIVE.md`. Over 54 complete `.logicx` projects
were already in Google Drive, 2022 through January 2025, from ad-hoc uploads
rather than any backup policy.

Rebuild procedure: `MAC-REBUILD.md`.

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

**ufw locks you out of Meshnet too.** Enabling it without an SSH rule does not
merely close the LAN route — NordVPN's mesh traffic lands in the same INPUT
chain, so `<host>.nord` goes dark at the same instant. There is no second way
in. `chord` was lost this way in October and needed a monitor carried to it.

Two habits prevent it, and the second matters more than it looks:

```bash
sudo -v                      # authenticate ONCE, then paste
sudo ufw allow 22/tcp        # before --force enable, every time
```

Without `sudo -v` first, pasting a block means the lines after the one that
triggers the password prompt are **read as the password**. They never run, sudo
reports incorrect attempts, and you are left with a firewall that enabled
itself without the rule that keeps you in the building.

**Password auth is already off, and nobody chose that.** The installer disables
it automatically when you import a GitHub identity at install time — it does not
ask. The default is right, but it has a sharp edge: **a new machine cannot add
itself.** Its key has to arrive by a path the server already trusts.

Both `ssh-copy-id` and `cat key | ssh host 'cat >> authorized_keys'` need a
password login, so both fail with `Permission denied (publickey)` — which reads
like a key problem and is really a bootstrap problem. The two paths that work:

1. Add the new key at `github.com/settings/keys`, confirm GitHub is serving it
   (`curl -s https://github.com/<user>.keys | ssh-keygen -lf -`), then run
   `ssh-import-id gh:colimaforever` **at the server**, not from the new machine.
2. From a machine that is already authorised, append the new public key to
   `~/.ssh/authorized_keys` over SSH.

Order matters in (1): `ssh-import-id` run before the key is on GitHub pulls the
keys already present, reports success, and changes nothing.

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

---

## Who can reach whom

**The shape: three admin boxes, three servers that are leaves.** The Mac mini,
the Kamrui and dkcommunisst can reach everything. `chord`, `amp` and the 8930
reach *nothing* — they have no keypairs of their own and no reason to initiate a
connection to each other. The only server-to-server traffic in the estate is
chord calling the 8930 on port 5006, and that is HTTP, not SSH.

Three admin boxes rather than one is deliberate. In October 2026 the Mac was
erased; had it been the only way in, the whole estate would have gone dark with
it.

Every key is ED25519 and registered at `github.com/settings/keys`, so
`ssh-import-id gh:colimaforever` on a new box picks up all of them at once.
Fingerprints are public identifiers — they exist to be compared out loud — but
**no private key has ever left the machine that generated it, and none belongs
in this repo.**

| Key on GitHub | Private half lives on | Fingerprint |
| --- | --- | --- |
| `Clawdbot` | Kamrui (Windows side) | `SHA256:hIUYi7n1oENwyhKyYAJH9PJn8VOZCTlqKPWEtD9bC14` |
| `Mac-mini` | Mac mini | `SHA256:dfpBjERXeHThtaVC/GnibPEAZq8PwNLNEadl5aExuW4` |
| `dkcommunisst` | dkcommunisst (Windows side) | `SHA256:RYqKLuNxz/LVWE/NVsnY67NXQ439ynumxBQaNS9qmu8` |

Each admin box keeps the same four aliases — `chord`, `amp`, `xps`, `mac` — so a
command reads the same wherever you type it. All four use LAN addresses;
Meshnet names are for reaching the house from outside it.

### Revoking a key

**This is the part that bites, so read it before you need it.**
`ssh-import-id` only ever *adds*. Deleting a key from GitHub does nothing to a
host that already imported it — the line stays in `authorized_keys` and keeps
working. There is no propagation and no central revocation.

So removing a key means editing it out on **every host that ever imported it**:
`chord`, `amp`, `xps` (`~/.ssh/authorized_keys`) and the Mac (same path,
populated by `curl`). Delete it from GitHub first so no future import pulls it
back, then walk the list.

**Known loose end:** the Kamrui's WSL has a *separate* keypair at
`/home/truth/.ssh/id_ed25519` that is not on GitHub and not authorized anywhere.
Two identities on one machine is how an hour disappeared in October — WSL fell
back to passwords while the Windows side worked. Admin from PowerShell on both
Windows boxes; keys live in `C:\Users\<name>\.ssh`.

---

## Still open

- **An unidentified tunnel connector.** `cloudflared tunnel info` lists two
  connectors for `song-analyzer`: `chord`, and one up since 2026-10-12 19:06 UTC
  from public IP `187.13.176.105` — not this house. All traffic currently goes to
  it, so `api.methodictruth.com` still answers from the 8930 even though chord
  has taken over. Most likely the Kamrui running cloudflared behind NordVPN, with
  an ingress pointed at the 8930 over Meshnet. **If it is not the Kamrui, treat
  it as a credential leak and rotate the tunnel** — those files are the authority
  for the hostname.
- **`amp`** — ufw has its rules but was never enabled (the `--force enable` hit a
  stray bracket). Also still needs the lid drop-in
  (`HandleLidSwitch=ignore` — closing the laptop currently takes the server
  down), the LVM expand off the installer's ~100 GB, MAC randomisation off and a
  DHCP reservation.
- **`chord`'s YouTube path is weaker than the 8930's was.** Missing `cookies.txt`
  (scp only, never committed), the PO-token server, and Deno. Uploads are
  unaffected; YouTube links will see more 403s until those are carried across.
- **The stems service** is written and committed but deployed nowhere. See
  `chord-server/STEMS.md`.
- **Bass detection** ships off (`BASS_DETECTION=1` to try it). The margins were
  reasoned, not measured — nobody has heard it run on real audio.
- **The Kamrui** — destroy `~/.cloudflared/` and `cookies.txt` before it is ever
  repurposed. Both are live credentials, and the first is now a suspect above.
- **Five GitHub Actions secrets** still unset, so the traffic reports have no
  data: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `GMAIL_USER`,
  `GMAIL_APP_PASSWORD`, `ALERT_EMAIL`. These get entered in GitHub directly,
  never pasted into a chat.
- **The Mac** — Logic, plugins and licences, per `MAC-REBUILD.md`. And the thing
  that caused all of this: Time Machine running, FileVault key stored off the
  machine.
