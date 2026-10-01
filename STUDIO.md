# Studio setup, workflow and conventions

Reference for anyone (human or agent) working on studio-related pages of this
site. Recorded 2026-09-27 from the owner's own description. The public-facing
version is `studio.html`; the Portastudio guide is `portastudio.html`.

## Goal

Hybrid hardware + computer studio for **dark, atmospheric electronic music with
an 80s / post-punk / goth character** — Clan of Xymox as a stated reference
point, around 107 BPM.

Governing philosophy:

> **Digital precision → hardware character → cassette → digital mix**

Logic is not being replaced. The Portastudio is a *tape-processing stage inside*
a hybrid workflow, not an alternative to the DAW.

## Core rig

| Role | Gear |
| --- | --- |
| Computer / DAW | Mac mini · Logic Pro |
| Interface | Focusrite Clarett+ 8Pre |
| Analog mixer | SSL SiX |
| Patchbay | 24-in, 2-row |
| MIDI | MOTU MIDI Express 128 (replaced a failed Sonos MT70) |
| Synths | Korg MS-2000B · Korg Minilogue · Roland JV-1010 · Roland VC-340 |
| Drums | Roland R-8 · Behringer RD-8 |
| Guitar / bass | Gibson Les Paul · 2007 MIM Fender Jazz Bass |
| Outboard FX | Roland RE-202 · Fostex 3180 · Yamaha R-1000 |
| Pedals | Way Huge Green Rhino · Ibanez FL-9 · Boss Dimension C Waza |
| Tape | Tascam Portastudio 424 mkIII · Maxell XL-II (Type II, C-60) |
| Monitoring | Beyerdynamic DT 770 PRO 80Ω |

Guitar chain: `Les Paul → Green Rhino → FL-9 → Dimension C → RE-202`

VC-340 is used around **500–800 Hz** for spectral balance in arrangements.

R-8 MIDI config: **MIDI clock only**, pattern-quantised clock start based on
pattern length, **MTC/MMC off**.

## The 424 mkIII — facts that matter

**Two different output sets. Do not conflate them.**

- **LINE OUTPUT L/R** — the mixer's stereo master. Faders, pan, EQ and returns
  applied. This is a mix, not tracks.
- **TAPE OUTPUTS 1–4** — four RCA jacks fed *directly from tape tracks 1–4*,
  bypassing the mixer. Nominally **−10 dBV**. These are what make multitrack
  transfer back into Logic possible.

Transfer cabling: **4 × RCA male → 1/4" TS male**, TAPE OUT 1–4 into Clarett
inputs 1–4.

**Tape stock: Type II high bias.** The machine's record electronics are
internally adjusted for it; the manual names TDK SA and Maxell XL-II. C-90 or
shorter, never C-120. Stick to one brand — bias is a calibration.

**Format:** true 4-track across the full tape width, *not* stereo A/B sides.
Tracks 3 and 4 occupy what a normal stereo deck uses for the reverse side, which
is why a standard cassette player cannot play a 424 tape properly.

**Speeds:** HIGH 9.5 cm/s (3¾ ips) · NORMAL 4.8 cm/s (1⅞ ips).

## Workflows

**A — Cassette as a processing stage (primary)**

```
Logic → Clarett outs → 424 inputs → record to cassette
cassette → 424 TAPE OUT 1–4 → Clarett 1–4 → Logic (4 fresh tracks)
```

Example stem assignment: drums→T1, bass→T2, synth→T3, guitar/VC-340→T4.

**B — Live tracking to tape**

```
instrument → 424 → cassette → TAPE OUT → Clarett → Logic
```

**C — Sampling an existing cassette**

```
prerecorded tape → 424 playback → output → Clarett → Logic
```

No need to dub onto a fresh multitrack tape first; do that only if a second tape
generation is wanted deliberately.

### Established principle

**The tape does not care whether the source was a live performance or a DAW
playback.** Same signal at the same level into the record input is processed the
same way. Everything that differs (feel, timing, gain staging, which effects are
committed) happens *before* the record head. Printing finished Logic material to
cassette is a fully legitimate way to get real tape colour.

The payoff is per-part choice: every stem can exist in both digital and tape
form, and the mix decides which — or blends them.

## Signal routing

### The one idea

Every piece of outboard is structurally identical:

```
Logic → Clarett OUT → [hardware] → Clarett IN → Logic
```

**Clarett outputs are ways out to hardware. Clarett inputs are ways back.**
The SSL compressor, the tape machine, the Space Echo — same shape, different
box. Once each is seen as a detour on that loop, the only question left is
which detour and in what order, which is what the patchbay answers.

### The three chains

**SSL compression on a part**

```
Logic track → Clarett OUT 1 → SSL CH1 (comp + EQ) → SSL Main → Clarett IN 1 → Logic
```

Two channel strips means two mono sources at a time. For a stereo source use
the **master bus compressor** and feed the SiX's stereo input instead.

**Tape saturation** — the one chain with a gap in the middle, since it is not
real time:

```
Logic stems   → Clarett OUT 3-6 → 424 channels 1-4 → record to tape
tape playback → 424 TAPE OUT 1-4 → Clarett IN 3-6 → Logic
```

**Hardware effects** — set up in Logic exactly like a plugin send, except the
plugin is a box with a tape loop in it:

```
Logic aux send → Clarett OUT 7 → RE-202 → Clarett IN 7/8 → Logic aux return
```

### The constraint

**8 out, 8 in.** A stereo round trip costs 2 and 2; a mono costs 1 and 1. So
roughly **four mono inserts or two stereo** can be live at once. That ceiling is
why the patchbay exists — repatch rather than buy I/O.

### Patchbay — two Neutrik NYS-SPP-L1, 48 points

Map: `studio-patchbay.csv`.

**Leave both bays at factory settings.** The NYS-SPP-L1 ships half-normalled with
the grey jack on the bottom row, which is what this layout wants everywhere. No
cards to flip.

Because they were bought used, **check before racking**: grey jacks on the bottom
row means half-normalled and correct. Grey on top means a previous owner changed
it — two screws off the front, slide the jack card out, flip it, reinsert. Do that
on the bench, never with cable dressed into the back.

**A device is not "on" a row.** Its outputs are on the top row, its inputs on the
bottom, so most gear appears in both. The 424 is the clearest case: tape outs and
line outs on top, channel inputs on the bottom.

The normal runs straight down inside one column. Half-normalled means a cable in
the **bottom** jack breaks it, while a cable in the **top** jack takes a copy
without disturbing anything.

**Bay A** is the loop — everything moving audio between Logic and hardware.
**Bay B** is sources — instruments. Bay B's bottom row is mostly empty, which is
correct: a sources bay produces signal, and the destinations all live in Bay A.

Two things the second bay buys:

- **424 channels 5–6** are reachable, so the MS-2000B plays straight to tape with
  no computer in the path.
- **The 424's own effect sends** have points, so the tape machine drives the
  Fostex directly and prints real spring reverb to tape rather than routing every
  effect through Logic.

`424 EFFECT SEND 2 doubles as TAPE CUE` — if it seems dead, check the mode before
suspecting a fault.

The bays are balanced TRS; the RCA→TS cables are unbalanced TS. That is fine — a
TS plug in a TRS jack shorts ring to sleeve, which is correct for an unbalanced
signal.

### Two habits worth keeping

**Do not compress everything on the way in.** Two channel compressors and one bus
compressor is the scarcest resource in the rack. Print clean, then insert the SSL
on the two or three parts that need it — usually bass, lead vocal, drum bus.

**Do not print everything to tape.** Running the whole arrangement through the 424
flattens the record. Pick the elements where the saturation is the point.

### Still to confirm

Marked `VERIFY` in the CSV, all unverified against real rear panels:

- **Fostex 3180** — jack count and connector format (points A21, A19)
- **Yamaha R-1000** — mono or stereo in, connector format (A20, A22, A23)
- **424 effect returns** — whether they exist and how many (A21, A22)
- **Korg Minilogue** — output count; the layout assumes one (B27)

Confirm these before cutting cable to them. Everything else comes from the
documented setup.

## Open discrepancies with `studio.html`

Flagged rather than silently reconciled — the site page and the owner's core-rig
list disagree, and both may be right (the list is "core", not exhaustive):

- `studio.html` lists **Korg MS-20 Mini**; the core list says **Korg MS-2000B**.
  Entirely different instruments. Unresolved.
- `studio.html` lists **Fostex 3510**; the core list says **Fostex 3180**.
  Unresolved.
- Present on `studio.html`, absent from the core list: Roland Juno DS, Akai
  Timbre Wolf, Alesis SR-16, Jolana Tornado, Denon Prime GO+, 2× Boss DD-7, Boss
  multi-FX board, KVLT Drums, Melodyne.
- Present in the core list, historically absent from `studio.html`: Mac mini,
  Fender Jazz Bass, DT 770 PRO, patchbay size, cassette stock.
