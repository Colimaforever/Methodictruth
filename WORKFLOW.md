# Studio Workflow

Everything in one place. `STUDIO.md` has the gear facts, `studio-patchbay.csv`
has the wiring map, `studio-routing.html` has the diagrams. This is the order
you do things in.

---

## The one idea

```
Logic → Clarett OUT → [hardware] → Clarett IN → Logic
```

Every **colour box** does the same thing structurally. **Clarett outputs are ways
out to hardware. Clarett inputs are ways back.** The tape machine, the Space Echo
and the spring reverb are the same shape with a different thing in the middle.

The patchbay exists so you can change what's in the middle without crawling
behind anything.

**The SSL SiX is the exception, and it matters.** The console is a *terminus*: it
sums, and it is where you listen from. Every bay instrument lands there and goes
no further until you ask it to.

Which raises the obvious problem — if the console sums everything, how do you
record one channel without recording your monitoring with it? **Bus B.** On the
SiX a channel's Mute button does not kill it; it routes that channel to Bus B
instead of the main mix. So Mute is a per-channel record send: that channel,
through its own EQ and dynamics, on its own, out `A9`/`A10` into Clarett IN 7–8.

The main out is therefore *not* the return path. It sits on `A23`/`A24` with an
open bottom jack, for the one job it is right for — printing a finished mix.

And the guard that holds the whole thing together: **EXT 1 carries Logic, and
EXT 1 stays off the mix bus.** That one setting is what stops Logic reaching the
main mix or Bus B while you record from them. Without it, Logic records itself.

---

## What each box is for

| | Job | Speed |
| --- | --- | --- |
| **SSL SiX** | Makes something **more itself** — tightens transients, controls dynamics | Real-time. Audition freely. |
| **424 mkIII** | Makes something **sit with other things** — saturates, softens, glues | A pass. Print, rewind, capture. |
| **Patchbay** | Changes the route in seconds instead of minutes | — |

**Need to control level or transients → SSL.**
**Need to add texture or weight → 424.**

Scarcity: two SSL channel strips and one bus compressor, against six 424
channels. Spend the SSL on the two or three parts that need dynamic control.

---

## The five stages

**Decide one thing per pass.** Writing decides notes, tracking decides
performances, arranging decides structure, colour decides sound, mixing decides
balance. Never decide the sound and the arrangement at the same time.

1. **Write** — no cables, SSL in tracking mode. Logic sequences everything
   through the MOTU and you hear all the hardware on the SSL. **Record only
   MIDI.** Choose sounds and parts freely; nothing is committed.
2. **Track** — turn each hardware part into audio in Logic.
   - Default to **raw**: take a top-jack copy into Clarett IN 3–6.
   - Record **through the SSL** (Mute → Bus B → IN 7–8) only when you already
     know the part wants it — usually drums.
   - Unsure? Record both versions in one take.
   - Name tracks by source *and* version: `Juno raw`, `Drums SSL`.
   - The MS-2000B, Minilogue and R-8 go in through the **front** inputs 1–2, one
     at a time.
3. **Arrange** — Logic only; leave the hardware alone. Cut, mute and move until
   the song works with everything still rough.
4. **Colour** — ⚠️ **the only irreversible stage.** Pick three or four elements
   for tape: drums, bass, one pad or the VC-340, and guitar.
   - Put a sharp click one bar before the music.
   - Send the stems to Clarett outs 3–6 and record them on the 424.
   - Rewind, play, capture the four tape tracks, align them on the click.
   - Not right? Re-print just that element.
5. **Mix** — in Logic, each tape version beside its original. Keep one or blend
   both. For SSL glue at the end, switch to mix print mode and print through the
   bus compressor.

Stages 1–3 are free. Stage 4 commits sound. Stage 5 is free again — **only
because the tape returns as four separate tracks rather than a mix.**

The loop you'll actually use: you're mixing, the drums want more grit, you
re-print just the drums, and carry on.

---

# Part A · Build it (once)

**Order matters. Test after each device, never all at the end.**

## The layout decision, before any cable

**Everything permanent lives on the rack table.** That means every point on Bay A
is a short run to gear sitting right next to it — wire it once, never touch the
back again.

**Instruments across the room are not wired in.** The MS-2000B, MS-20 Mini and
anything else at a distance get a long cable into a **front bottom jack** when
wanted. Costs zero patchbay points, leaves no cable permanently strung across the
floor, and pulls straight back out when you're done.

**Bay B is the sources, not the overflow.** The four instruments that live near
the rack (Juno DS, VC-340, JV-1010, and the RD-8 via the 12R), the guitar chain,
and the effect returns. `B15`–`B24` stay free — a point costs nothing until
something earns it, and free points mean the next piece of gear doesn't force a
rewire.

**Mount Bay A where you can reach it** — in the rack, near the Clarett and SSL.
Those are the points you'll touch daily.

**The Mac mini is not a constraint either way.** The Thunderbolt run from the
rack table to the dock in the computer corner is confirmed to make the distance,
so the Mac mini *can* stay in the corner. It can also move to the rack table
with the dock, which is better if there is room — a short Thunderbolt run beats
a long one, and you stop standing up mid-session.

Either way **the rack table is the anchor for Bay A**, the patchbay map does not
change, and every audio cable stays short. If the Mac mini and dock do come
over, two things to watch:

- **Keep the XPS tower out of it.** It is a fan-heavy desktop you reach over
  Meshnet and SSH — it has no reason to sit next to a microphone. The Mac mini
  is near-silent and you touch it constantly; the tower is the opposite of both.
- **Hum.** Computer switching supplies next to audio gear invite ground loops,
  and the most susceptible thing in the room is the 424's unbalanced −10 dBV
  RCA tape returns (`A11`–`A14`). If you hear hum appear after the move, that is
  where it will be. Try a different outlet before you blame a cable.

**Put the 424 somewhere with clear space above it.** Its jacks are on the **top
panel**, not the back, so don't bury it mid-rack with something sitting on it.

## Steps

1. **Photograph** every rear panel and the current patch state.
2. **Power down** everything. Not standby.
3. **Consolidate power** onto one strip, one circuit. Do this before any audio
   cable. Ground loops are the most likely thing to ruin the day.
4. Route **power down one side**, audio down the other. Cross at 90°.
5. **Verify the bays on the bench, with the Fluke.** Continuity between rear top
   and rear bottom of the same column:
   - *Beeps with nothing plugged* → connected. Good.
   - *Now plug a cable into the front bottom and re-test* → should **stop**
     beeping. That's half-normalled with the break on the bottom. Correct.
   - *Still beeps* → the break is on the top row. Flip that card: two screws off
     the front, slide the jack card out, reverse it, reinsert.
   - Test two or three columns per bay; they're all alike unless someone went to
     trouble.
   Never open a bay with cable dressed into the back.
6. **Note the ground tabs** on the bay — `CHASSIS COMMON / TOP / BOTTOM`. Leave
   them as found. If hum survives the single-power-strip fix, lifting a ground
   here is the next lever, and it helps to know it exists before you need it.
7. **Wire the spine first**: Clarett OUT 1–2 → `A1`/`A2`, SSL Main → `A9`/`A10`.
8. **Power up and test that one loop.** Logic track out, through the SSL, back in.
   Listen for signal, then for hum with nothing playing.
9. **Add the rest of Bay A one device at a time**, testing each: the 424 channel
   inputs (`A3`–`A6`), tape outs (`A11`–`A14`), RE-202 (`A7`, `A15`–`A16`),
   R-1000 (`A8`, `A22`–`A23`), Fostex (`A19`, `A21`), line outs (`A17`–`A18`).
10. **Wire Bay B's six destinations** — `B1`–`B6`. Leave the rest.
11. **Dress**: service loops so any unit pulls forward without unplugging.
    Velcro, never zip ties. Labels on **both** ends.
12. Photograph the finished state. Tick the **Done** column in the CSV.

Keep something playing through the system the whole time. You'll hear the moment
something breaks instead of finding out five cables later.

## Using an instrument that isn't wired in

Long cable from the instrument → **front bottom jack** of whatever destination you
want. `B1` reaches 424 channel 5. Any point on Bay A whose bottom is a Clarett
input sends it straight to the interface.

Never plug a source into a front **top** jack — tops are outputs, you take *from*
them. The rule holds: **take from a top, give to a bottom.**

That run is long and unbalanced, so a TRS cable buys nothing — synth outputs are
unbalanced regardless. Keep it on the opposite side of the room from power, cross
at 90°, and if one instrument hums while others don't, a DI box at the instrument
end balances it and fixes it properly.

# Part B · The 424's first session

**Before any tape goes in:**

1. **Look at it** — pinch roller not glazed or flat-spotted, heads not caked, no
   melted-rubber smell.
2. **Clean the heads** — 99% isopropyl on a cotton swab: record/play head, erase
   head, capstan, pinch roller. Before the first tape, not after.
3. **Transport test** on a tape you don't care about: play, FF, rewind, record.

**Settings to learn on:**

Speed **HIGH** (3¾ ips) · **dbx on** · **Type II** tape (Maxell XL-II) ·
counter zeroed · DT 770s in PHONES.

**The first exercise — eight bars of drums, not a song:**

1. Put a **sharp click one bar before the music** in Logic. Most important step.
2. Send it out to 424 channel 1. RECORD FUNCTION → **DIRECT**. Arm track 1.
3. Set **TRIM** so loud hits read healthy without pinning. Trim, not fader.
4. Record. Rewind. **Switch monitoring to tape** — if it sounds identical you're
   still hearing the input and haven't heard the tape at all.
5. Capture **TAPE OUT 1** into a fresh Logic track. Align on the click.
6. A/B them. Listen to the **transients** — kick attack, hi-hats.

Then twice more: **drive it hard** (trim until the meters complain), and **fill
all four tracks** in one pass.

---

# Part C · Making a song

1. **Write and sequence in Logic.** MIDI out through the MOTU to the synths and
   drum machines.
2. **Track the hardware** in through the patchbay. Use the SSL on anything that
   needs control on the way in.
3. **Arrange until the song actually works.** Do not go to tape before this.
4. **Pick three or four elements for tape.** Not everything — the contrast
   between tape-coloured and clean is what makes the colour read.
   Usual picks: RD-8 drums, bass, one pad or the VC-340, guitar.
5. **Print them.** Repatch Clarett OUT 3–6 → 424 channels 1–4, RECORD FUNCTION
   DIRECT, one stem per tape track. Shape with the 424's EQ and sends as you go —
   this is where character gets committed.
   Signal order that usually works: `Logic → SSL (shape) → 424 (saturate) → tape`
6. **Play back and capture.** TAPE OUT 1–4 → Clarett IN 3–6 → four fresh tracks.
   Align on the click.
7. **Mix in Logic** with tape versions alongside the untouched digital ones.
   Decide per element which you keep, or blend both.
8. **SSL bus compressor** on the stereo mix if you want that glue.

**The loop you'll actually use:** mixing, hear the drums want more saturation,
re-print just the drums, carry on. It is not a one-way assembly line.

---

## Gotchas

**Tape never returns in sync.** Converter latency plus the transport never
starting at the same instant. The click at the head is what you align on — and
since all four tracks come off one tape, aligning that one marker aligns all four.

**"The tape does nothing"** is almost always monitoring the input instead of the
tape return.

**LINE OUT is monitoring. TAPE OUT 1–4 is capture.** Mixing the machine's stereo
output would freeze every balance decision.

**EFFECT SEND 2 doubles as TAPE CUE.** If it seems dead, check the mode before
suspecting a fault.

**RCA tape outs are −10 dBV unbalanced.** They'll arrive quiet and need make-up
gain. That's operating level, not a fault. Keep those runs short and away from mains.

**Print in song-length chunks**, not long passes — drift accumulates.

**Write the tape counter number down.** A cassette tells you nothing about where
you are.

**Never route a Clarett Analogue input to a line output.** In Focusrite Control
each output carries its matching Logic *playback* channel and nothing else.
Breaking that rule is what caused the June feedback loop, when the SSL master
came back out of outputs 5–6.

**Logic must never reach the main mix or Bus B while you record from them**, or
Logic records itself. Keeping EXT 1 off the mix bus guarantees it. The single
exception is printing a finished mix — then EXT 1 goes on the mix bus and you
record with input monitoring **off**.

**Mute on the SiX is a send, not a kill.** A muted channel leaves the main mix
and goes to Bus B. That is the feature the whole tracking path is built on, and
it will surprise you the first time you mute something expecting silence.

**Front inputs 1–2 are deliberately empty.** They are the guitar and bass DI, and
the reason tape capture lives on inputs 3–6 rather than 1–4.

**Interface not detected? Plug it into the computer, not the dock.** Thunderbolt
audio is PCIe over the wire and needs guaranteed bandwidth; a dock shares that
budget with displays, ethernet and USB, and a display will take most of it. The
Clarett wants its own port on the machine. Everything else goes through the dock.

Failing that, in order: power the interface **on before** the computer boots
(Thunderbolt enumerates at connect, not on demand); confirm the cable is an
actual Thunderbolt cable and not a USB-C charging cable, which fits the port and
behaves erratically; and check whether it disappears specifically after sleep.

To tell a bus problem from a driver problem: look for the device in **System
Information → Thunderbolt** (macOS) or **Thunderbolt Control Center** (Windows).
Listed there but missing in the DAW is software. Not listed at all is cable,
port, dock or power — don't reinstall drivers for that.

---

## Still to verify

Before wiring:

- **SSL headphones** — do they follow the monitor matrix? The whole EXT 1 plan
  assumes yes, so check this first.
- **SSL Bus B** — stereo out, and does a muted channel keep its EQ, dynamics and
  fader on the way there?
- **SSL inserts** — separate send and return jacks on CH1, CH2 and the mix bus?
  If not, `A19`–`A22` come out of the map.
- **VC-340** — true stereo out, or one output? If mono, `B6` frees up and SSL ST2
  pans centre.
- **Yamaha R-1000** — mono or stereo input?
- **Alesis 12R** — any spare channels? The MS-2000B or Minilogue could ride along
  with the RD-8 and skip the floor cable entirely.
- **Patch bays** — grey normalling jacks on the bottom row. If they're on top,
  flip the card.

Fostex 3180 confirmed **mono in, mono out** — one point each way.
