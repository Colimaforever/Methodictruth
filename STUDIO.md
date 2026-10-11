# Studio setup, workflow and conventions

Reference for anyone (human or agent) working on studio-related pages of this
site. The public-facing version is `studio.html`; the Portastudio guide is
`portastudio.html`.

**Source of truth: the owner's *Studio Reference & Patch Bay Map* doc,
rev 20, 2026-10-11.** The routing below was rebuilt from it and supersedes the
2026-09-27 version recorded from an earlier description. Where this file and
that doc disagree, the doc wins — it is the one being edited at the rack.

## Goal

Hybrid hardware + computer studio for **dark, atmospheric electronic music with
an 80s / post-punk / goth character** — Clan of Xymox as a stated reference
point, around 107 BPM.

Governing philosophy:

> **Digital precision → hardware character → cassette → digital mix**

Logic is not being replaced. The Portastudio is a *tape-processing stage inside*
a hybrid workflow, not an alternative to the DAW.

## Describing it in one line

For when someone asks. Pick the length that fits.

**One line**
> Hybrid studio: Logic writes it, an SSL SiX is the analog hub, a cassette
> 4-track prints the character, and it all comes back into Logic to mix.

**One line, with the sound**
> A hybrid hardware studio for dark, atmospheric 80s/post-punk music — Logic
> sequences, an SSL SiX and a Tascam 424 cassette deck give it character, and
> everything returns to Logic as fresh tracks.

**A paragraph**
> Two centres. Logic Pro on a Mac mini is where it gets written and mixed; an SSL
> SiX is where the analog side converges and where I listen from. A Clarett 8Pre
> joins them. Hanging off that are the colour boxes — a Space Echo, a spring
> reverb, an 80s digital reverb, and a Tascam 424 cassette 4-track — each one a
> detour out of the interface and back in. The 424 is the unusual part: it isn't
> the recorder, it's a saturation stage. Stems get printed to tape and pulled back
> in as new tracks, so every part can exist in both digital and tape form and the
> mix picks. Aimed at dark, atmospheric 80s/post-punk, around 107 BPM.

**Out loud, casually**
> I write in Logic, run the parts out through analog gear and a cassette 4-track
> to rough them up, then bring them back in to mix. Tape does something to a
> sound I can't get any other way.

**The gear, in one breath**
> Mac mini and Logic · Clarett 8Pre · SSL SiX · Tascam 424 mkIII · RE-202,
> Fostex 3180 spring, Yamaha R-1000 · Korg MS-2000B, Minilogue, MS-20 Mini ·
> Roland Juno DS, JV-1010 · Behringer VC-340 and RD-8 · Roland R-8 · Les Paul
> and a Jazz Bass.

## Core rig

| Role | Gear |
| --- | --- |
| Computer / DAW | Mac mini · Logic Pro — arrangement, MIDI, editing, final mix, export |
| Interface | Focusrite Clarett 8Pre — inputs 1–2 on the **front**, 3–8 on the back; line outs 1–10 |
| Analog mixer | SSL SiX — 2 mono channel strips, 2 stereo channels, 2 stereo EXT inputs, Bus B record send, channel + mix-bus inserts, bus compressor. **No direct outs per channel** |
| Patchbay | 2× Neutrik NYS-SPP-L1 — 24 columns each (48 total), 2-row, half-normalled (Bay A, Bay B) |
| MIDI | MOTU MIDI Express 128 (replaced a failed Sonos MT70) |
| Synths | Korg MS-2000B · Korg Minilogue · Korg MS-20 Mini · Roland Juno DS · Roland JV-1010 · Behringer VC-340 |
| Drums | Roland R-8 · Behringer RD-8 — individual outs into an **Alesis 12R submixer** |
| Guitar / bass | Gibson Les Paul · 2007 MIM Fender Jazz Bass |
| Outboard FX | Roland RE-202 · Fostex 3180 (mono in/out) · Yamaha R-1000 |
| Pedals | Way Huge Green Rhino · Ibanez FL-9 · Boss Dimension C Waza |
| Tape | Tascam Portastudio 424 mkIII · Maxell XL-II (Type II, C-60) · **HIGH speed, dbx on** |
| Monitoring | Beyerdynamic DT 770 PRO 80Ω — **no speakers** |

**In the patch bay:** Juno DS, VC-340, JV-1010 and the RD-8 (via the 12R). The
MS-2000B, Minilogue, MS-20 Mini, R-8, guitar and bass sit too far away and cable
in directly — see *Instruments not wired in* below.

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

### The shape of it

Three zones, each with a different cost of changing your mind. The patch bay is
the switchboard between them.

| Zone | What it does | Cost of changing your mind |
| --- | --- | --- |
| **Logic** | MIDI, editing, arrangement, final mix | Free, any time |
| **SSL** | Live shaping — EQ, compression, glue | Free while you listen; fixed once recorded |
| **Tape** | Saturation, softening, character | Committed; re-print to change it |

Logic is the notebook, the SSL is your hands, the tape is the ink. Stay raw and
editable as long as possible; commit only when you know what the song needs.

### Bus B is the record send — not the main out

This is the piece that makes the whole thing work, and it is not obvious.

**On the SiX, a channel's Mute button does not kill it — it sends that channel
to Bus B instead of the main mix.** So Mute is a per-channel record send:
processed through that channel's EQ and dynamics, on its own, without the rest
of the console coming with it. Bus B lands on `A9`/`A10` → Clarett IN 7–8.

That is why the main out is *not* the return path. It carries everything live on
the console, so recording from it would print your monitoring into the take. The
main out sits on `A23`/`A24` with an open bottom, for the one job it is right
for: printing a finished mix.

### The feedback guard

**EXT 1 carries Logic, and EXT 1 stays off the mix bus.** That single setting is
what stops Logic reaching the console's main mix or Bus B while you record from
them — otherwise Logic records itself.

The one exception is printing a finished mix: EXT 1 goes on the mix bus, and you
record with input monitoring **off**.

The two EXT inputs are set differently on purpose:

- **EXT 1 (Logic)** → monitors only. Never the mix bus, except when printing.
- **EXT 2 (JV-1010)** → on the mix bus. Gives the JV level only, no EQ or
  dynamics, which suits a MIDI-driven module.

### With nothing plugged in

The studio is already ready to write. Every bay instrument plays through the
SSL, Logic is in your headphones, a Logic print lands on the 424, and tape
playback lands back in Logic. **Most sessions need no patch cables at all.**

### Why tape capture uses Clarett IN 3–6

Inputs **1–2 are on the front panel** and stay free for guitar and bass DI.
Tape outs 1–4 therefore land on 3–6, and Bus B takes 7–8.

### Levels

Clarett outputs run at **+4 dBu**; the 424 expects **−10 dBV**. Start the 424's
TRIM low when printing and bring it up. Coming back, tape outs arrive at −10 dBV,
so expect to add gain on Clarett IN 3–6 — that is operating level, not a fault.

Print in song-length chunks. Tape speed drift accumulates over long passes.

### Focusrite Control

Every output carries its matching Logic playback channel and nothing else:

| Clarett output | Set to |
| --- | --- |
| Monitor / Line 1–2 | Playback 1–2 |
| Line 3–4 | Playback 3–4 |
| Line 5–6 | Playback 5–6 |
| Line 7–8 | Playback 7–8 |

**Never route an Analogue input to a line output.** That is what caused the June
feedback loop, when the SSL master came back out of outputs 5–6.

### SSL SiX — two modes

| Setting | Tracking (default) | Mix print |
| --- | --- | --- |
| EXT 1 (Logic) to mix bus | Off | On |
| EXT 1 in monitor matrix | On | Off — you hear it in the mix |
| EXT 2 (JV-1010) to mix bus | On | On, or off if the JV isn't in the song |
| Bus B in monitor matrix | On when tracking through the SSL | Off |
| Main mix in monitor matrix | On | On |

### Patchbay — two Neutrik NYS-SPP-L1, 48 columns

Map: `studio-patchbay.csv`.

**Bay A is the spine:** Logic (Clarett) ⇄ SSL ⇄ 424 ⇄ effect sends, plus the SSL
channel and mix-bus inserts.
**Bay B is the sources:** the four bay instruments, the guitar chain, and the
effect returns.

**Top row = outputs. Bottom row = inputs.** Every column pairs a source with the
destination it should feed by default.

- **Half-normalled:** with nothing plugged in, top feeds bottom.
- **Plug into a top jack to take a copy** — the default keeps working.
- **Plug into a bottom jack to override** — your cable replaces the default.
- A column marked `(open)` has nothing on its bottom jack: its source goes
  somewhere only when you patch it.
- `B15`–`B24` are spare.

**Leave both bays at factory settings.** The NYS-SPP-L1 ships half-normalled with
the grey jack on the bottom row, which is what this layout wants everywhere.
Because they were bought used, check before racking: grey on the bottom is
correct; grey on top means a previous owner changed it — two screws, slide the
card out, flip it, reinsert, on the bench rather than with cable dressed in.

**A device is not "on" a row.** Its outputs are on top, its inputs on the bottom,
so most gear appears in both.

The bays are balanced TRS; the 424's RCA→TS cables are unbalanced. That is fine —
a TS plug in a TRS jack shorts ring to sleeve, which is correct for an
unbalanced signal. Wire the 424's RCA tape outs with RCA→¼" TS, and the SSL's
XLR main outs with XLR→TRS.

### Common patches

| Task | Patch cables | How it works |
| --- | --- | --- |
| Write and jam | **None** | Hardware plays through the SSL; Logic is in your headphones via EXT 1 |
| Track a part raw | Instrument top (`B1`–`B8`) → Clarett IN bottom (`A11`–`A14`) | A copy, so you still hear it on the SSL. Dry and unprocessed |
| Track a part through the SSL | **None** | Press that channel's Mute. It leaves the main mix for Bus B → Clarett IN 7–8. Select Bus B in the monitor matrix to keep hearing it |
| Both versions of one take | Instrument top → `A11`/`A12` bottom, **plus** Mute | Raw and processed recorded at once; choose later |
| Guitar through the chain | `B10`/`B11` top → `A13`/`A14` bottom | RE-202 out into Clarett IN 5–6. Or skip the bay and use front inputs 1–2 |
| Print stems to tape | **None** | Send stems to Clarett outs 3–6; they land on 424 inputs 1–4 |
| Shape on the SSL before tape | `A3` top → `B1` bottom, then `A9` top → `A3` bottom | Stem 1 goes into SSL CH1 instead of the drums; mute CH1 and Bus B feeds 424 IN 1 |
| Hear the 424 on the SSL | `A15`/`A16` top → `B7`/`B8` bottom | 424 LINE OUT replaces the JV-1010 on EXT 2 |
| Capture tape | **None** | Pull any tracking cables from `A11`–`A14`. Tape outs land on Clarett IN 3–6 |
| Logic send to the Space Echo | `A7` top → `B9` bottom | Clarett OUT 7 still feeds the R-1000 too, but its return goes nowhere — harmless |
| Wet return back into Logic | `B10`–`B14` top → `A11`–`A14` bottom | Record the effect return on its own track |
| Outboard on a channel insert | `A19` top → effect in, effect out → `A19` bottom | Same with `A20` for CH2 |
| Effect or tape across the mix | `A21`/`A22` top → device in, device out → `A21`/`A22` bottom | Uses the SSL mix bus insert |
| Print the final mix | `A23`/`A24` top → `A11`/`A12` bottom | Switch EXT 1 to the mix bus first, record with input monitoring **off** |

### Two habits worth keeping

**Do not compress everything on the way in.** Two channel strips and one bus
compressor is the scarcest resource in the rack. Print clean, then insert the SSL
on the two or three parts that need it.

**Do not print everything to tape.** Running the whole arrangement through the
424 flattens the record. Pick the elements where the saturation is the point.

### Still to confirm

To verify before wiring:

- **SSL headphones** — do they follow the monitor matrix? The whole EXT 1 plan
  assumes yes.
- **SSL Bus B** — stereo out, and does a muted channel keep its EQ, dynamics and
  fader on the way there?
- **SSL inserts** — separate send and return jacks on CH1, CH2 and the mix bus?
  If not, drop `A19`–`A22`.
- **VC-340** — true stereo out, or one output? If mono, `B6` frees up and ST2
  pans centre.
- **Yamaha R-1000** — mono or stereo input?
- **Alesis 12R** — any spare channels? The MS-2000B or Minilogue could ride along
  with the RD-8.
- **Patch bays** — grey normalling jacks on the bottom row. If they're on top,
  flip the card.

### Build order

Test after each step, with something playing the whole time.

1. Photograph every rear panel and the current patching
2. Power everything down; put all audio gear on one power strip
3. Wire the spine — `A1`/`A2` (Logic → SSL EXT 1) and `A9`/`A10` (Bus B →
   Clarett IN 7–8). Test for signal and hum
4. Wire Bay B instruments, `B1`–`B8`, and test each on the SSL
5. Wire the 424 — `A3`–`A6` and `A11`–`A14` — then run an eight-bar print and
   capture test
6. Wire effects and inserts — `A7`/`A8`, `A19`–`A24`, `B9`–`B14` — one at a time
7. Set Focusrite Control as in the table above
8. Label both ends of every cable and both bay strips, then photograph the
   finished state

## Instruments not wired in

In the bay: **Juno DS, VC-340, JV-1010** and the **RD-8** via the 12R. Everything
below sits too far away, and is patched in on demand — a long cable into a
**front bottom jack**, costing zero patchbay points. `B15`–`B24` are spare if any
of them move closer.

- **MS-20 Mini · MS-2000B · Minilogue** — shared stand across the room
- **Roland R-8** — stored under the bed, brought out when wanted
- **Guitar and bass** — straight into the Clarett's **front** inputs 1–2, which
  are deliberately kept free for exactly this
- **Multi-FX pedalboard** — a floor unit, so it belongs on the floor. Patch it
  in when wanted; it has not earned a permanent point. Brand unresolved:
  `studio.html` records a **BOSS** multi-FX pedalboard, the owner recalls a
  **Korg**. Possibly two units, possibly one misremembered.

Leave two or three long cables permanently run from the stand to near the bay,
coiled with free ends, rather than dragging one across the floor each session.
The R-8 is stereo, so it needs two on its own.

The cheaper option worth checking first: **does the Alesis 12R have spare
channels?** It is already in the bay carrying the RD-8, so an MS-2000B or
Minilogue plugged into it would reach the SSL with no new patchbay point and no
cable across the floor.

## Open discrepancies with `studio.html`

Flagged rather than silently reconciled — the site page and the owner's core-rig
list disagree, and both may be right (the list is "core", not exhaustive):

- ~~MS-20 Mini vs MS-2000B~~ — **resolved: both are owned.** They share a stand
  with the Minilogue: MS-20 Mini on top, MS-2000B in the middle, Minilogue below.
  The core list was a subset, not a correction.
- `studio.html` lists **Fostex 3510**; the core list says **Fostex 3180**.
  Unresolved.
- Present on `studio.html`, absent from the core list: Roland Juno DS, Akai
  Timbre Wolf, Alesis SR-16, Jolana Tornado, Denon Prime GO+, 2× Boss DD-7, Boss
  multi-FX board, KVLT Drums, Melodyne.
- Present in the core list, historically absent from `studio.html`: Mac mini,
  Fender Jazz Bass, DT 770 PRO, patchbay size, cassette stock.
