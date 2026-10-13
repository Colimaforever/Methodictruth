# Rebuilding the Mac mini

Written in October 2026, the morning the mini stopped booting and landed on
*Activate Mac* with no recovery key saved anywhere. Everything in here is the
part that lives on the computer. The hardware side — patching, routing, levels,
Focusrite Control values — is already in `STUDIO.md` and `WORKFLOW.md` and is
not repeated.

**The order matters more than the list.** Most of the pain in a studio rebuild
comes from doing the right things in the wrong sequence.

---

## Start these first — they have turnaround, not a progress bar

Everything in this section is email or waiting. Begin it before you touch the
machine, so it's resolving while you install.

**Release your plugin license seats.** This is the one thing that genuinely
blocks a rebuild. You cannot deauthorize a Mac you cannot boot, and most vendors
cap activations. Write to each one, say the machine is dead and unbootable, ask
them to release the seat. They do it routinely — but it's a support queue, not a
button, and discovering it mid-install on a Saturday is how a weekend goes.

| License type | What happens when the machine dies | What to do |
| --- | --- | --- |
| Account-based (oeksound and most modern plugins) | Seat stays consumed | Email support, ask for a reset |
| Computer-bound (Celemony/Melodyne and similar) | Activation is stranded | Vendor support; they expect this request |
| iLok **Cloud** or USB dongle | Nothing — it was never on the Mac | Just sign in / plug in |
| iLok **local machine** activation | Stranded on the dead disk | iLok support; recoverable, slowly |

**Logic Pro itself is safe.** It's a Mac App Store purchase tied to your Apple
ID, so it redownloads free, as do the sound libraries.

---

## Order of operations

1. **Create the account with the same short username.** This matters more than
   it looks: Logic projects and sample libraries store **absolute paths** under
   `/Users/<name>/`. Matching the old username makes a large class of "missing
   file" dialogs simply not happen.

2. **Turn FileVault on — and put the recovery key somewhere that is not this
   Mac.** A photo on your phone counts. A note in a password manager counts. The
   key written down and left in a drawer counts. What does not count is clicking
   past the dialog, which is the decision that produced this document.

3. **Set up a backup before installing anything else.** An external drive and
   Time Machine, switched on while the machine is still empty and boring. The
   habit only ever forms before there's something to lose.

4. **Logic Pro, then its sound library.** Roughly 70 GB and it'll want an
   evening. Do it before plugins.

5. **Plugins, after Logic exists.** Logic's AU scan runs at first launch after
   an install; installing plugins first just means scanning twice. Expect
   Gatekeeper to object to older installers — right-click → Open, not a
   security setting change.

6. **Focusrite driver and Focusrite Control.** Set the output matrix exactly as
   `STUDIO.md` has it: every output carries its matching **Playback** channel
   and nothing else. **Never route an Analogue input to a line output** — that
   is the June feedback loop, and it is a two-click mistake to repeat.

7. **MOTU MIDI Express 128 driver**, then confirm the synths appear in Audio
   MIDI Setup before blaming Logic for anything.

8. **Restore projects from Drive** (below).

---

## The things nobody remembers until they're missing

Not hard, just invisible — none of it announces itself, and all of it is the
difference between "Logic is installed" and "the studio works again."

- **Logic I/O labels.** Naming inputs and outputs for what's actually plugged
  into them is per-system and entirely manual. Rebuild it from
  `studio-patchbay.csv` — tape outs on IN 3–6, Bus B on IN 7–8.
- **Key commands.** Export them to Drive the day you finish reconfiguring.
- **Templates and channel strip settings.** Same — these are small files and
  there is no reason for them to exist only locally.
- **Audio MIDI Setup:** sample rate and clock source, set once and then
  forgotten about for a year until something sounds wrong.
- **Logic preferences:** buffer size for tracking vs mixing, record file type,
  and the autosave interval.

---

## Restoring projects from Drive

A `.logicx` project is a **folder that macOS displays as a file**. Uploaded to
Drive it becomes an ordinary folder, which is why the Drive copies look like
directory trees full of `Project File Backups` — that's Logic's own autosave
folder, from inside the package.

To bring one back:

1. Download the whole folder.
2. Rename it `Name.logicx` on the Mac.
3. It becomes a project again and opens normally.

**Open one and play it before assuming the rest are fine.** Check that audio
regions are present rather than greyed out — if the project referenced samples
outside the package, Logic will ask where they went, and that's the moment to
find out whether the backup was complete.

Drive coverage is uneven: heaviest around late 2023 and January 2025, with
`TheColimaMethod` and the plugin presets from August 2025. Anything newer than
that may only have existed on the mini.

---

## What not to repeat

Three habits, each of which would have made this a non-event:

1. **The FileVault recovery key never lives only on the machine it unlocks.**
2. **Time Machine runs.** A studio Mac with no backup is a single disk holding
   work that exists nowhere else.
3. **Finished and in-progress projects sync somewhere.** The Drive copies are
   the only reason this was a bad morning rather than a catastrophe, and they
   were an accident rather than a policy.

`MACHINES.md` describes the mini as "the machine that holds the only
irreplaceable data in the house." That sentence was true when it was written and
should not be true again.
