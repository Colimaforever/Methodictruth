/* chord-shapes.js — turns a chord symbol into something you can actually play.
 *
 * Parses a chord name, generates piano voicings (inversions, open, shell) and
 * guitar fingerings (CAGED shapes + top-string triad inversions), and renders
 * either as SVG. Shared by the Song Analyzer's "How To Play" panel and the
 * Chord Voicings page. No dependencies; exposes only window.ChordShapes.
 *
 * Dot colours follow the site-wide convention set on fretboard.html:
 * amber = root, purple = the quality tone (3rd, or the 2/4 of a sus chord),
 * green = 5th, cyan = 7th and upper extensions.
 */
(function (global) {
  'use strict';

  const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  // Suffix → intervals, in semitones from the root. Intervals above an octave
  // are kept unreduced (14, not 2) so the degree label can read "9" not "2".
  const QUALITIES = [
    ['maj9',  [0, 4, 7, 11, 14]],
    ['maj7',  [0, 4, 7, 11]],
    ['m7b5',  [0, 3, 6, 10]],
    ['min7',  [0, 3, 7, 10]],
    ['dim7',  [0, 3, 6, 9]],
    ['sus2',  [0, 2, 7]],
    ['sus4',  [0, 5, 7]],
    ['add9',  [0, 4, 7, 14]],
    ['min',   [0, 3, 7]],
    ['dim',   [0, 3, 6]],
    ['aug',   [0, 4, 8]],
    ['m9',    [0, 3, 7, 10, 14]],
    ['m7',    [0, 3, 7, 10]],
    ['m6',    [0, 3, 7, 9]],
    ['m',     [0, 3, 7]],
    ['9',     [0, 4, 7, 10, 14]],
    ['7',     [0, 4, 7, 10]],
    ['6',     [0, 4, 7, 9]],
    ['5',     [0, 7]],
    ['',      [0, 4, 7]]
  ];

  const QUALITY_NAMES = {
    '': 'major', 'm': 'minor', 'min': 'minor', '7': 'dominant 7th',
    'maj7': 'major 7th', 'm7': 'minor 7th', 'min7': 'minor 7th',
    'm7b5': 'half-diminished', 'dim': 'diminished', 'dim7': 'diminished 7th',
    'aug': 'augmented', 'sus2': 'suspended 2nd', 'sus4': 'suspended 4th',
    '6': 'major 6th', 'm6': 'minor 6th', '9': 'dominant 9th',
    'maj9': 'major 9th', 'm9': 'minor 9th', 'add9': 'add 9', '5': 'power chord'
  };

  // Every quality the engine can build, in the order a musician would scan
  // them: the common ones first, colour and extensions after.
  const QUALITY_LIST = [
    { suffix: '',      name: 'Major' },
    { suffix: 'm',     name: 'Minor' },
    { suffix: '7',     name: 'Dominant 7' },
    { suffix: 'maj7',  name: 'Major 7' },
    { suffix: 'm7',    name: 'Minor 7' },
    { suffix: '6',     name: 'Major 6' },
    { suffix: 'm6',    name: 'Minor 6' },
    { suffix: 'sus2',  name: 'Sus2' },
    { suffix: 'sus4',  name: 'Sus4' },
    { suffix: 'add9',  name: 'Add 9' },
    { suffix: 'dim',   name: 'Diminished' },
    { suffix: 'dim7',  name: 'Diminished 7' },
    { suffix: 'm7b5',  name: 'Half-diminished' },
    { suffix: 'aug',   name: 'Augmented' },
    { suffix: '9',     name: 'Dominant 9' },
    { suffix: 'maj9',  name: 'Major 9' },
    { suffix: 'm9',    name: 'Minor 9' },
    { suffix: '5',     name: 'Power chord (no 3rd)' }
  ];

  const DEGREE_LABEL = {
    0: 'R', 1: '♭9', 2: '2', 3: '♭3', 4: '3', 5: '4', 6: '♭5',
    7: '5', 8: '♯5', 9: '6', 10: '♭7', 11: '7',
    13: '♭9', 14: '9', 17: '11', 21: '13'
  };

  const OPEN_PC = [4, 9, 2, 7, 11, 4];          // E A D G B e, as pitch classes
  const OPEN_MIDI = [40, 45, 50, 55, 59, 64];   // the same strings, as MIDI
  const STRING_NAMES = ['E', 'A', 'D', 'G', 'B', 'e'];
  const MAX_FRET = 14;

  const mod12 = n => ((n % 12) + 12) % 12;

  function pcName(pc) { return PC_NAMES[mod12(pc)]; }

  function midiName(m) { return PC_NAMES[mod12(m)] + (Math.floor(m / 12) - 1); }

  function degreeLabel(iv) { return DEGREE_LABEL[iv] || DEGREE_LABEL[mod12(iv)] || String(iv); }

  // Which colour slot a degree occupies. 2/b3/3/4 all share the "quality" slot
  // because in a sus chord the 2 or 4 is doing the third's job.
  function roleOf(iv) {
    const m = mod12(iv);
    if (m === 0) return 'r';
    if (m >= 2 && m <= 5) return '3';
    if (m >= 6 && m <= 8) return '5';
    return '7';
  }

  // ─── Parsing ───────────────────────────────────────────────────────────────

  function parseChord(symbol) {
    if (!symbol || typeof symbol !== 'string') return null;
    const s = symbol.trim().replace(/♭/g, 'b').replace(/♯/g, '#');
    const m = /^([A-Ga-g])([#b]?)(.*)$/.exec(s);
    if (!m) return null;

    const letter = m[1].toUpperCase();
    let rootPc = LETTER_PC[letter];
    if (m[2] === '#') rootPc += 1;
    else if (m[2] === 'b') rootPc -= 1;
    rootPc = mod12(rootPc);

    // Strip a slash bass ("C/G") — remember it, it changes the lowest note.
    let rest = m[3], bassPc = null;
    const slash = rest.indexOf('/');
    if (slash >= 0) {
      const bm = /^([A-Ga-g])([#b]?)$/.exec(rest.slice(slash + 1).trim());
      if (bm) {
        let b = LETTER_PC[bm[1].toUpperCase()];
        if (bm[2] === '#') b += 1; else if (bm[2] === 'b') b -= 1;
        bassPc = mod12(b);
      }
      rest = rest.slice(0, slash);
    }

    const suffix = rest.trim();
    const found = QUALITIES.find(q => q[0].toLowerCase() === suffix.toLowerCase());
    if (!found) return null;

    return {
      symbol: pcName(rootPc) + suffix,
      rootPc,
      rootName: pcName(rootPc),
      suffix,
      bassPc,
      intervals: found[1].slice(),
      qualityName: QUALITY_NAMES[suffix.toLowerCase()] || suffix,
      // Pitch classes in the chord, root first.
      pcs: found[1].map(i => mod12(rootPc + i))
    };
  }

  // The interval (possibly compound, so 9ths label correctly) that a pitch
  // class represents in this chord.
  function intervalForPc(pc, chord) {
    const m = mod12(pc - chord.rootPc);
    for (const iv of chord.intervals) if (mod12(iv) === m) return iv;
    return m;
  }

  // ─── Piano voicings ────────────────────────────────────────────────────────

  function invert(notes, times) {
    const out = notes.slice().sort((a, b) => a - b);
    for (let k = 0; k < times; k++) out.push(out.shift() + 12);
    return out.sort((a, b) => a - b);
  }

  const ORDINALS = ['Root position', '1st inversion', '2nd inversion', '3rd inversion', '4th inversion'];

  function pianoVoicings(chord) {
    if (!chord) return [];
    const base = 48 + chord.rootPc;                 // C3 upward, so it reads low
    const root = chord.intervals.map(i => base + i);
    const n = root.length;
    const out = [];

    out.push({
      id: 'root', name: ORDINALS[0], notes: root,
      hint: 'The plain stack — root at the bottom, then up through the chord tones.'
    });

    for (let k = 1; k < n; k++) {
      out.push({
        id: 'inv' + k,
        name: ORDINALS[k] || (k + 'th inversion'),
        notes: invert(root, k),
        hint: `${pcName(chord.pcs[k])} in the bass. Same chord, different centre of gravity — ` +
              'use it to keep your hand still between changes.'
      });
    }

    // Open position: lift the second-lowest tone an octave. On a triad this is
    // the classic R-5-3 spread every pianist reaches for.
    const open = root.slice();
    open[1] += 12;
    out.push({
      id: 'open', name: 'Open / spread', notes: open.slice().sort((a, b) => a - b),
      hint: 'Wider and less muddy than a close stack. Better in the low register, ' +
            'and it leaves room for a melody on top.'
    });

    if (n >= 4) {
      out.push({
        id: 'shell', name: 'Shell (R-3-7)',
        notes: [base, base + chord.intervals[1], base + chord.intervals[3]],
        hint: 'Drop the 5th. The 3rd and 7th carry the harmony on their own — ' +
              'the jazz comping default, and it stays out of the bass player\'s way.'
      });
      out.push({
        id: 'rootless', name: 'Rootless (3-5-7)',
        notes: chord.intervals.slice(1, 4).map(i => base + i),
        hint: 'No root at all. Works whenever a bass is covering it, and it ' +
              'voice-leads beautifully between chords.'
      });
    }

    out.push({
      id: 'bass', name: 'Bass + chord',
      notes: [base - 12].concat(root),
      hint: 'Left hand on the octave-down root, right hand on the chord. ' +
            'The most solid way to play it solo.'
    });

    // A slash chord asks for a specific bass note; honour it.
    if (chord.bassPc !== null) {
      let b = 36 + chord.bassPc;
      while (b >= Math.min.apply(null, root)) b -= 12;
      out.unshift({
        id: 'slash', name: pcName(chord.bassPc) + ' in the bass',
        notes: [b].concat(root),
        hint: 'The written slash bass, under the chord.'
      });
    }

    return out;
  }

  // ─── Guitar voicings ───────────────────────────────────────────────────────

  // Lowest fret at or above minFret, within one hand position, whose note
  // belongs to the chord. Mirrors how a hand actually finds notes.
  function findFret(openPc, minFret, allowedPcs) {
    for (let f = minFret; f <= minFret + 5 && f <= MAX_FRET; f++) {
      if (allowedPcs.indexOf(mod12(openPc + f)) >= 0) return f;
    }
    return null;
  }

  function describe(frets, chord) {
    return frets.map((f, s) => {
      if (f === null) return { string: s, fret: null, muted: true };
      const pc = mod12(OPEN_PC[s] + f);
      const iv = intervalForPc(pc, chord);
      return {
        string: s, fret: f, muted: false, pc,
        note: pcName(pc), degree: degreeLabel(iv), role: roleOf(iv)
      };
    });
  }

  function ordinalFret(n) {
    if (n % 100 >= 11 && n % 100 <= 13) return n + 'th';
    return n + (['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  }

  const CAGED = [
    { label: 'E-shape', rootString: 0,
      open: 'Open E-family voicing — full and ringing, all six strings.',
      barre: 'Root on the low E string. The fullest sound you can get, but the most tiring.' },
    { label: 'A-shape', rootString: 1,
      open: 'Open A-family voicing — bright and direct.',
      barre: 'Root on the 5th string. Easier reach than the E-shape, and it sits higher in a mix.' },
    { label: 'D-shape', rootString: 2,
      open: 'Open D-family voicing — light and chiming.',
      barre: 'Top four strings only. Easiest on the hand, and it stays out of the bass.' }
  ];

  function cagedShape(chord, tpl) {
    const allowed = chord.pcs;
    const barreFret = mod12(chord.rootPc - OPEN_PC[tpl.rootString]);
    const frets = [];
    for (let s = 0; s < 6; s++) {
      frets.push(s < tpl.rootString ? null : findFret(OPEN_PC[s], barreFret, allowed));
    }
    if (frets.filter(f => f !== null).length < 3) return null;
    return {
      id: tpl.label,
      name: tpl.label + (barreFret === 0 ? ' (open)' : ' · ' + ordinalFret(barreFret) + ' fret'),
      frets,
      strings: describe(frets, chord),
      hint: barreFret === 0 ? tpl.open : tpl.barre
    };
  }

  // Three chord tones on one set of adjacent strings — the guitar's real
  // inversions. Each rotation puts a different tone on the lowest string.
  function stringSetTriad(chord, set, rotation) {
    const tones = chord.pcs;
    const pcs = [0, 1, 2].map(i => tones[(rotation + i) % 3]);
    const frets = [null, null, null, null, null, null];
    let prevPitch = -1;
    for (let i = 0; i < set.length; i++) {
      const s = set[i];
      let f = mod12(pcs[i] - OPEN_PC[s]);
      while (OPEN_MIDI[s] + f <= prevPitch) f += 12;
      if (f > MAX_FRET) return null;
      frets[s] = f;
      prevPitch = OPEN_MIDI[s] + f;
    }
    const used = set.map(s => frets[s]);
    if (Math.max.apply(null, used) - Math.min.apply(null, used) > 4) return null;
    return {
      id: 'set' + set[0] + '-' + rotation,
      name: 'Top-string triad · ' + (ORDINALS[rotation] || rotation + 'th inversion'),
      frets,
      strings: describe(frets, chord),
      hint: rotation === 0
        ? 'Three notes on the top three strings, root lowest. Light, clean, and easy to move.'
        : `${pcName(pcs[0])} on the bottom. Same three notes as the shape before it, ` +
          'rolled around — this is how you get inversions on a guitar.'
    };
  }

  function guitarVoicings(chord) {
    if (!chord) return [];
    const out = [];
    const seen = new Set();
    const add = v => {
      if (!v) return;
      const key = v.frets.join(',');
      if (seen.has(key)) return;
      seen.add(key);
      out.push(v);
    };

    CAGED.forEach(tpl => add(cagedShape(chord, tpl)));
    if (chord.intervals.length === 3) {
      for (let r = 0; r < 3; r++) add(stringSetTriad(chord, [3, 4, 5], r));
    }
    return out;
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Guitar chord box. Six strings, five fret spaces, dots coloured by degree.
  function renderChordBox(voicing) {
    const L = 26, R = 10, SP = 18, TOP = 30, FH = 20, FRETS = 5;
    const W = L + SP * 5 + R, H = TOP + FH * FRETS + 20;
    const played = voicing.strings.filter(s => !s.muted && s.fret > 0).map(s => s.fret);
    const maxF = played.length ? Math.max.apply(null, played) : 0;
    const minF = played.length ? Math.min.apply(null, played) : 0;
    const base = maxF <= FRETS ? 1 : minF;      // show the nut when the shape reaches it
    const x = i => L + i * SP;
    const y = f => TOP + (f - base + 0.5) * FH;

    let svg = `<svg class="cs-box" viewBox="0 0 ${W} ${H}" role="img" ` +
              `aria-label="${esc(voicing.name)} chord diagram">`;

    // Fret wires, then strings.
    for (let f = 0; f <= FRETS; f++) {
      svg += `<line class="cs-fret" x1="${x(0)}" y1="${TOP + f * FH}" x2="${x(5)}" y2="${TOP + f * FH}"/>`;
    }
    if (base === 1) svg += `<rect class="cs-nut" x="${x(0) - 1}" y="${TOP - 4}" width="${SP * 5 + 2}" height="4"/>`;
    else svg += `<text class="cs-basefret" x="${x(0) - 7}" y="${TOP + FH * 0.72}">${base}fr</text>`;
    for (let s = 0; s < 6; s++) {
      svg += `<line class="cs-string" x1="${x(s)}" y1="${TOP}" x2="${x(s)}" y2="${TOP + FH * FRETS}"/>`;
    }

    voicing.strings.forEach(st => {
      const sx = x(st.string);
      if (st.muted) {
        svg += `<text class="cs-mark cs-mark-x" x="${sx}" y="${TOP - 8}">×</text>`;
      } else if (st.fret === 0) {
        svg += `<text class="cs-mark cs-mark-o" x="${sx}" y="${TOP - 8}">○</text>`;
        svg += `<text class="cs-open-deg cs-deg-${st.role}" x="${sx}" y="${TOP + FH * FRETS + 13}">${esc(st.degree)}</text>`;
      } else {
        svg += `<circle class="cs-dot cs-dot-${st.role}" cx="${sx}" cy="${y(st.fret)}" r="7.5"/>`;
        svg += `<text class="cs-dtxt" x="${sx}" y="${y(st.fret) + 2.7}">${esc(st.degree)}</text>`;
      }
    });

    return svg + '</svg>';
  }

  // Piano keyboard. The span is derived from the voicing, rounded out to whole
  // octaves, so any voicing — however wide — fits without clipping.
  function renderPiano(notes, chord) {
    const WW = 17, WH = 80, BW = 11, BH = 50;
    const WHITE = [0, 2, 4, 5, 7, 9, 11];
    const lo = Math.floor(Math.min.apply(null, notes) / 12) * 12;
    let hi = Math.ceil((Math.max.apply(null, notes) + 1) / 12) * 12 - 1;
    if (hi - lo < 23) hi = lo + 23;              // never narrower than two octaves

    const on = new Map(notes.map(n => [n, true]));
    const keys = [];
    let wi = 0;
    for (let m = lo; m <= hi; m++) {
      const black = WHITE.indexOf(mod12(m)) < 0;
      if (black) keys.push({ m, black, x: wi * WW - BW / 2 });
      else keys.push({ m, black, x: wi++ * WW });
    }
    const W = wi * WW, H = WH + 18;

    const degOf = m => {
      const iv = intervalForPc(mod12(m), chord);
      return { label: degreeLabel(iv), role: roleOf(iv) };
    };

    let svg = `<svg class="cs-piano" viewBox="0 0 ${W} ${H}" role="img" ` +
              `aria-label="${esc(chord.symbol)} on a keyboard">`;

    keys.filter(k => !k.black).forEach(k => {
      const lit = on.has(k.m);
      const d = lit ? degOf(k.m) : null;
      svg += `<rect class="cs-key cs-key-w${lit ? ' cs-lit cs-fill-' + d.role : ''}" ` +
             `x="${k.x}" y="0" width="${WW}" height="${WH}" rx="2"/>`;
      if (lit) svg += `<text class="cs-kdeg" x="${k.x + WW / 2}" y="${WH - 9}">${esc(d.label)}</text>`;
    });
    keys.filter(k => k.black).forEach(k => {
      const lit = on.has(k.m);
      const d = lit ? degOf(k.m) : null;
      svg += `<rect class="cs-key cs-key-b${lit ? ' cs-lit cs-fill-' + d.role : ''}" ` +
             `x="${k.x}" y="0" width="${BW}" height="${BH}" rx="1.5"/>`;
      if (lit) svg += `<text class="cs-kdeg cs-kdeg-b" x="${k.x + BW / 2}" y="${BH - 7}">${esc(d.label)}</text>`;
    });

    // Octave markers under every C, so the register is readable at a glance.
    keys.filter(k => !k.black && mod12(k.m) === 0).forEach(k => {
      svg += `<text class="cs-oct" x="${k.x + WW / 2}" y="${H - 4}">${esc(midiName(k.m))}</text>`;
    });

    return svg + '</svg>';
  }

  // ─── Audio preview ─────────────────────────────────────────────────────────
  // A plain triangle-wave stack with a soft envelope. Enough to check that a
  // voicing sounds the way it looks; not trying to be the synth page.

  let actx = null;

  function playNotes(notes, opts) {
    const o = opts || {};
    try {
      if (!actx) {
        const Ctx = global.AudioContext || global.webkitAudioContext;
        if (!Ctx) return false;
        actx = new Ctx();
      }
      if (actx.state === 'suspended') actx.resume();
    } catch (e) { return false; }

    const t0 = actx.currentTime + 0.02;
    const stagger = o.arpeggio ? 0.085 : 0;
    const dur = o.duration || 1.5;
    const bus = actx.createGain();
    bus.gain.value = 0.9 / Math.max(3, notes.length);
    bus.connect(actx.destination);

    notes.slice().sort((a, b) => a - b).forEach((m, i) => {
      const t = t0 + i * stagger;
      const osc = actx.createOscillator();
      const g = actx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = 440 * Math.pow(2, (m - 69) / 12);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(1, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.25);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g); g.connect(bus);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    });
    return true;
  }

  // Turn a guitar fingering into pitches so it can be previewed too.
  function voicingToMidi(voicing) {
    return voicing.strings.filter(s => !s.muted).map(s => OPEN_MIDI[s.string] + s.fret);
  }

  function fretsText(voicing) {
    return voicing.frets.map(f => (f === null ? 'x' : f)).join(' ');
  }

  global.ChordShapes = {
    parseChord, pianoVoicings, guitarVoicings,
    renderPiano, renderChordBox,
    playNotes, voicingToMidi, fretsText,
    midiName, pcName, degreeLabel, roleOf,
    STRING_NAMES, PC_NAMES, QUALITY_LIST
  };
})(window);
