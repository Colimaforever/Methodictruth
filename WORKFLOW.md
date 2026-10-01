# Studio Workflow

Everything in one place. `STUDIO.md` has the gear facts, `studio-patchbay.csv`
has the wiring map, `studio-routing.html` has the diagrams. This is the order
you do things in.

---

## The one idea

```
Logic → Clarett OUT → [hardware] → Clarett IN → Logic
```

Every box does the same thing structurally. **Clarett outputs are ways out to
hardware. Clarett inputs are ways back.** The SSL, the tape machine and the
Space Echo are the same shape with a different thing in the middle.

The patchbay exists so you can change what's in the middle without crawling
behind anything.

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

1. **Write** — Logic sequences MIDI, hardware makes sound. Nothing recorded.
2. **Track** — hardware audio → patchbay → Clarett → Logic.
3. **Arrange** — structure the song. Everything still editable.
4. **Colour** — ⚠️ **the only irreversible stage.** SSL and tape.
5. **Mix** — balance, automate, master.

Stages 1–3 are free. Stage 4 commits sound. Stage 5 is free again — **only
because the tape returns as four separate tracks rather than a mix.**

---

# Part A · Build it (once)

**Order matters. Test after each device, never all at the end.**

1. **Photograph** every rear panel and the current patch state.
2. **Power down** everything. Not standby.
3. **Consolidate power** onto one strip, one circuit. Do this before any audio
   cable. Ground loops are the most likely thing to ruin the day.
4. Route **power down one side** of the rack, audio down the other. Cross at 90°.
5. **Check the patchbays on the bench.** Grey jacks on the bottom row = half
   normalled = correct. Grey on top = flip the card (two screws). Never open a
   bay with cable dressed into it.
6. **Wire the spine first**: Clarett OUT 1–2 → bay 1–2, SSL Main → bay 9–10.
7. **Power up and test that one loop.** Logic track out, through the SSL, back in.
   Listen for signal, then for hum with nothing playing.
8. **Add effects one at a time**, testing each: RE-202 (7, 15–16), R-1000
   (8, 22–23), Fostex (19, 21).
9. **Label points 3–6 and 11–14 for the 424 now**, even before cabling them.
10. **Dress**: service loops so any unit pulls forward without unplugging.
    Velcro, never zip ties. Labels on **both** ends.
11. Photograph the finished state. Tick the **Done** column in the CSV.

Keep something playing through the system the whole time. You'll hear the moment
something breaks instead of finding out five cables later.

---

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

---

## Still to verify

- **Yamaha R-1000** — mono or stereo in
- **424 effect returns** — do they exist, how many
- **Korg Minilogue** — one output or two

Fostex 3180 confirmed **mono in, mono out** — one point each way.
