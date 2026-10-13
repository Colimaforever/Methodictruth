/* Chord analysis → Standard MIDI File, written in the browser.
 *
 * The analyzer already does the hard part. By the time this runs the page has
 * the tempo, the meter, bar-aligned measures with a detected downbeat phase,
 * the key, and the section map. All that is left is to voice the chords and
 * write the bytes — so this needs no endpoint, no server work, and no network.
 *
 * Deliberately one track (format 0). The point is to drag the file onto a
 * single instrument and have a plugin play the progression, so the bass note
 * and the chord tones live together on one channel rather than being split
 * across tracks that then need two patches.
 *
 * Depends on ChordShapes.parseChord for symbol → pitch classes.
 */
(function (global) {
  'use strict';

  const TPQ = 480;             // ticks per quarter note
  const CHANNEL = 0;
  const VEL_CHORD = 78;
  const VEL_BASS = 92;         // the root slightly stronger, as a player would

  // Chord tones are kept inside this window. Below it triads turn to mud;
  // above it they stop sounding like accompaniment.
  const LOW = 48;              // C3
  const HIGH = 79;             // G5

  // ─── byte helpers ──────────────────────────────────────────────────────────

  // MIDI delta times are variable-length: 7 bits per byte, high bit set on
  // every byte but the last.
  function vlq(n) {
    const out = [n & 0x7f];
    n >>= 7;
    while (n > 0) { out.unshift((n & 0x7f) | 0x80); n >>= 7; }
    return out;
  }

  function bytes(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) out.push(str.charCodeAt(i) & 0xff);
    return out;
  }

  function u32(n) { return [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]; }
  function u16(n) { return [(n >> 8) & 0xff, n & 0xff]; }

  // ─── key signature ─────────────────────────────────────────────────────────

  // sf = sharps (positive) or flats (negative). Where a pitch class could be
  // spelled either way, prefer the spelling musicians actually use: Bb minor
  // over A# minor, G# minor over Ab minor.
  const MAJOR_SF = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5];
  const MINOR_SF = [-3, 4, -1, -6, 1, -4, 3, -2, 5, 0, -5, 2];

  const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  function keySignature(keyName) {
    if (!keyName) return null;
    const m = /^([A-G])([#b]?)\s*(major|minor)$/i.exec(String(keyName).trim());
    if (!m) return null;
    let pc = PC[m[1].toUpperCase()];
    if (m[2] === '#') pc += 1; else if (m[2] === 'b') pc -= 1;
    pc = ((pc % 12) + 12) % 12;
    const minor = m[3].toLowerCase() === 'minor';
    return { sf: minor ? MINOR_SF[pc] : MAJOR_SF[pc], mi: minor ? 1 : 0 };
  }

  // ─── voicing ───────────────────────────────────────────────────────────────

  // How far this voicing sits from the previous one. Summing each note's
  // distance to the nearest previous note is a cheap stand-in for real voice
  // leading, and it is enough to stop the progression jumping an octave
  // between every change — which is what makes a naive export sound like a
  // test file rather than a part.
  function motion(notes, prev) {
    let total = 0;
    for (const n of notes) {
      let best = Infinity;
      for (const p of prev) best = Math.min(best, Math.abs(n - p));
      total += best;
    }
    return total;
  }

  // Build every inversion across a couple of octaves, keep the ones inside the
  // register window, and pick whichever moves least from the chord before it.
  function voiceChord(chord, prev) {
    const ivs = chord.intervals;
    let best = null, bestCost = Infinity;

    for (let inv = 0; inv < ivs.length; inv++) {
      for (let oct = -1; oct <= 1; oct++) {
        const notes = [];
        for (let k = 0; k < ivs.length; k++) {
          let n = LOW + 12 * oct + chord.rootPc + ivs[(inv + k) % ivs.length];
          // Stack upward: each tone goes above the last, which is what turns a
          // rotation into an actual inversion rather than a reordered set.
          while (notes.length && n <= notes[notes.length - 1]) n += 12;
          notes.push(n);
        }
        if (notes[0] < LOW || notes[notes.length - 1] > HIGH) continue;

        // With nothing to lead from, favour a voicing centred near middle C.
        const cost = prev ? motion(notes, prev)
                          : Math.abs(notes[0] - 55) + Math.abs(notes[notes.length - 1] - 72);
        if (cost < bestCost) { bestCost = cost; best = notes; }
      }
    }

    return best || ivs.map(i => LOW + chord.rootPc + i);
  }

  // The root an octave or two under the chord. A slash chord puts its own bass
  // note here — that is the whole reason the symbol carries one.
  function bassNote(chord) {
    const pc = chord.bassPc != null ? chord.bassPc : chord.rootPc;
    let n = 36 + pc;                       // C2 upward
    while (n < 28) n += 12;
    while (n > 47) n -= 12;
    return n;
  }

  // ─── build ─────────────────────────────────────────────────────────────────

  /* data   — the analyzer response as displayResults() receives it
   * opts   — { quantize: true, bass: true }
   * returns { blob, filename, chordCount } or null if there is nothing to write
   */
  function build(data, opts) {
    opts = opts || {};
    const quantize = opts.quantize !== false;
    const withBass = opts.bass !== false;

    const chords = Array.isArray(data && data.chords) ? data.chords : [];
    if (!chords.length || !global.ChordShapes) return null;

    const bpm = Number(data.bpm_precise) || Number(data.bpm) || 120;
    const spb = 60 / bpm;
    const beatsPerBar = (data.meter && data.meter.beats_per_bar) || 4;

    // Anchor the grid on the first detected bar line rather than on zero. The
    // backend already worked out which beat is a downbeat; ignoring that would
    // put every chord a fraction of a beat early or late, which is exactly the
    // error that makes an imported file useless.
    const measures = Array.isArray(data.measures) ? data.measures : [];
    const anchor = measures.length ? Number(measures[0].start) || 0 : 0;

    // `snap` overrides the global setting. Chord changes are snapped because
    // they are a harmonic sketch and want to sit on bar lines; transcribed
    // parts are not, because where a note actually falls is the entire value
    // of a transcription and quantizing it would throw the performance away.
    function toTicks(seconds, snap) {
      let beats = (Number(seconds) - anchor) / spb;
      if (snap === undefined ? quantize : snap) beats = Math.round(beats);
      return Math.max(0, Math.round(beats * TPQ));
    }

    // Collapse repeats. The detector emits a label per half-bar, so a chord
    // held for eight bars arrives as sixteen identical entries; re-triggering
    // each one would machine-gun the plugin instead of sustaining.
    const events = [];
    for (const c of chords) {
      const name = c && (c.chord || c.name);
      if (!name || name === 'N' || name === 'N.C.') continue;
      // The backend reports the bass separately when it hears an inversion, so
      // C over E arrives as {chord:'C', bass:'E'} rather than as 'C/E'. Two
      // entries with the same chord but different bass are a real change — the
      // harmony stays put while the bass walks — so they must not collapse.
      const bass = (c && c.bass) || null;
      const tick = toTicks(c.timestamp);
      const last = events[events.length - 1];
      if (last && last.name === name && last.bass === bass) continue;
      if (last && last.tick === tick) { last.name = name; last.bass = bass; continue; }
      events.push({ name: name, bass: bass, tick: tick });
    }
    if (!events.length) return null;

    // Each chord runs until the next one. The last gets one bar, so the file
    // ends on a whole bar rather than a dangling note.
    const barTicks = TPQ * beatsPerBar;
    for (let i = 0; i < events.length; i++) {
      events[i].end = (i + 1 < events.length) ? events[i + 1].tick : events[i].tick + barTicks;
      if (events[i].end <= events[i].tick) events[i].end = events[i].tick + TPQ;
    }

    // ── event lists ──
    // Meta and chords are collected separately because the file format depends
    // on what else is present: chords alone are written as one merged format-0
    // track, so the file drops onto a single plugin; with transcribed parts
    // alongside it becomes format 1, one track each, so a DAW can give them
    // different instruments.
    const meta = [], chordEvents = [];
    function at(list) {
      return function (tick, order, arr) { list.push({ tick: tick, order: order, data: arr }); };
    }
    const pushMeta = at(meta), push = at(chordEvents);

    // Meta, all at tick 0. order -1 keeps them ahead of any note.
    const title = (data.title ? String(data.title) : 'Chord progression').slice(0, 120);
    pushMeta(0, -1, [0xff, 0x03].concat(vlq(bytes(title).length), bytes(title)));

    const usPerQuarter = Math.round(60000000 / bpm);
    pushMeta(0, -1, [0xff, 0x51, 0x03,
                     (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff]);

    // Denominator is a power of two as an exponent: 2 means quarter notes.
    pushMeta(0, -1, [0xff, 0x58, 0x04, beatsPerBar, 2, 24, 8]);

    const ks = keySignature(data.key);
    if (ks) pushMeta(0, -1, [0xff, 0x59, 0x02, ks.sf & 0xff, ks.mi]);

    // Section labels become markers, which Logic reads straight into its
    // arrangement track — so the structure survives the export, not just the
    // chords.
    if (Array.isArray(data.sections)) {
      data.sections.forEach(function (s, i) {
        const label = 'Section ' + (s.label || String.fromCharCode(65 + i));
        pushMeta(toTicks(s.start), -1, [0xff, 0x06].concat(vlq(bytes(label).length), bytes(label)));
      });
    }

    // Notes. Offs are ordered before ons at the same tick so a chord change
    // releases the old voicing before striking the new one.
    let prev = null, written = 0;
    for (const ev of events) {
      // Try the slash form first; fall back to the plain chord if this quality
      // is one parseChord does not know, so an unusual suffix costs the
      // inversion rather than the whole chord.
      let parsed = ev.bass ? global.ChordShapes.parseChord(ev.name + '/' + ev.bass) : null;
      if (!parsed) parsed = global.ChordShapes.parseChord(ev.name);
      if (!parsed) continue;

      const notes = voiceChord(parsed, prev);
      prev = notes;
      written++;

      const all = withBass ? [bassNote(parsed)].concat(notes) : notes.slice();
      all.forEach(function (n, idx) {
        const vel = (withBass && idx === 0) ? VEL_BASS : VEL_CHORD;
        push(ev.tick, 1, [0x90 | CHANNEL, n & 0x7f, vel]);
        push(ev.end, 0, [0x80 | CHANNEL, n & 0x7f, 0]);
      });
    }
    if (!written) return null;

    // ── transcribed parts, when the stems service has supplied them ──
    const parts = [];
    (Array.isArray(opts.tracks) ? opts.tracks : []).forEach(function (t, i) {
      const notes = (t && Array.isArray(t.notes)) ? t.notes : [];
      if (!notes.length) return;

      const list = [], add = at(list);
      const name = String(t.name || ('Part ' + (i + 1))).slice(0, 120);
      add(0, -1, [0xff, 0x03].concat(vlq(bytes(name).length), bytes(name)));

      // Channel 10 (index 9) is percussion in General MIDI — anything placed
      // there plays as a kit whatever the note numbers say, and anything NOT
      // placed there plays a drum part as pitches. Nothing else about the file
      // can fix that, so it has to be right here.
      const ch = t.drums ? 9 : Math.min(8, i + 1);

      notes.forEach(function (n) {
        const pitch = Math.max(0, Math.min(127, Math.round(Number(n.pitch))));
        const on = toTicks(n.start, false);
        const off = Math.max(on + 1, toTicks(n.end, false));
        const vel = Math.max(1, Math.min(127, Number(n.velocity) || VEL_CHORD));
        add(on, 1, [0x90 | ch, pitch, vel]);
        add(off, 0, [0x80 | ch, pitch, 0]);
      });
      parts.push(list);
    });

    function serialize(list) {
      list.sort(function (a, b) { return (a.tick - b.tick) || (a.order - b.order); });
      const out = [];
      let last = 0;
      for (const e of list) {
        out.push.apply(out, vlq(e.tick - last));
        out.push.apply(out, e.data);
        last = e.tick;
      }
      out.push.apply(out, [0x00, 0xff, 0x2f, 0x00]);   // end of track
      return out;
    }

    // Format 0 when the chords are all there is, so the file still drops onto
    // a single plugin exactly as before. Format 1 the moment there is a second
    // part, because merging a drum kit and a melody onto one channel would be
    // worse than not having them.
    if (parts.length) {
      // In a format-0 file the song title names the only track. Once the
      // chords are one track among several they need a name of their own, or
      // a DAW shows the song title on one track and blanks on the rest.
      const cn = bytes('Chords');
      chordEvents.push({ tick: 0, order: -2,
                         data: [0xff, 0x03].concat(vlq(cn.length), cn) });
    }

    const chunks = parts.length
      ? [serialize(meta), serialize(chordEvents)].concat(parts.map(serialize))
      : [serialize(meta.concat(chordEvents))];

    let file = [].concat(bytes('MThd'), u32(6),
                         u16(parts.length ? 1 : 0), u16(chunks.length), u16(TPQ));
    chunks.forEach(function (c) { file = file.concat(bytes('MTrk'), u32(c.length), c); });

    const safe = (data.title ? String(data.title) : 'chords')
      .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'chords';

    return {
      blob: new Blob([new Uint8Array(file)], { type: 'audio/midi' }),
      filename: safe + (parts.length ? '-full.mid' : '-chords.mid'),
      chordCount: written,
      trackCount: chunks.length
    };
  }

  function download(data, opts) {
    const built = build(data, opts);
    if (!built) return null;
    const url = URL.createObjectURL(built.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = built.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    return built;
  }

  global.MidiExport = { build: build, download: download };
})(window);
