// chord-theory.js — Chord identification and music theory utilities

// Convert MIDI note number to note name (C, C#, D, etc.)
function midiToNoteName(midi) {
  const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return noteNames[midi % 12];
}

// Get semitone intervals from root note
function getIntervalsFromRoot(midiNotes) {
  if (midiNotes.length === 0) return [];
  
  const sortedNotes = [...midiNotes].sort((a, b) => a - b);
  const root = sortedNotes[0];
  
  // Get intervals relative to root
  const intervals = sortedNotes.map(note => (note - root) % 12);
  
  // Remove duplicates and sort
  return [...new Set(intervals)].sort((a, b) => a - b);
}

// Chord identification database
const CHORD_PATTERNS = [
  // Power chords (two-note)
  { intervals: [0, 7], name: '5', fullName: 'Power Chord' },
  
  // Triads
  { intervals: [0, 4, 7], name: 'maj', fullName: 'Major' },
  { intervals: [0, 3, 7], name: 'min', fullName: 'Minor' },
  { intervals: [0, 3, 6], name: 'dim', fullName: 'Diminished' },
  { intervals: [0, 4, 8], name: 'aug', fullName: 'Augmented' },
  
  // Sus chords
  { intervals: [0, 2, 7], name: 'sus2', fullName: 'Suspended 2nd' },
  { intervals: [0, 5, 7], name: 'sus4', fullName: 'Suspended 4th' },
  
  // Seventh chords
  { intervals: [0, 4, 7, 11], name: 'maj7', fullName: 'Major 7th' },
  { intervals: [0, 3, 7, 10], name: 'min7', fullName: 'Minor 7th' },
  { intervals: [0, 4, 7, 10], name: '7', fullName: 'Dominant 7th' },
  { intervals: [0, 3, 6, 10], name: 'min7♭5', fullName: 'Half-Diminished' },
  { intervals: [0, 3, 6, 9], name: 'dim7', fullName: 'Diminished 7th' },
  
  // Extended chords
  { intervals: [0, 4, 7, 11, 14], name: 'maj9', fullName: 'Major 9th' },
  { intervals: [0, 3, 7, 10, 14], name: 'min9', fullName: 'Minor 9th' },
  { intervals: [0, 4, 7, 10, 14], name: '9', fullName: 'Dominant 9th' },
  
  // Add chords
  { intervals: [0, 2, 4, 7], name: 'add9', fullName: 'Add 9' },
  { intervals: [0, 4, 5, 7], name: 'add11', fullName: 'Add 11' },
  { intervals: [0, 4, 7, 9], name: 'add6', fullName: 'Add 6' },
  
  // Metal favorites (two-note intervals)
  { intervals: [0, 1], name: '♭9 interval', fullName: 'Minor 2nd' },
  { intervals: [0, 2], name: '9 interval', fullName: 'Major 2nd' },
  { intervals: [0, 3], name: '♭3 interval', fullName: 'Minor 3rd' },
  { intervals: [0, 4], name: '3 interval', fullName: 'Major 3rd' },
  { intervals: [0, 5], name: '4 interval', fullName: 'Perfect 4th' },
  { intervals: [0, 6], name: '♭5 interval', fullName: 'Tritone' },
  { intervals: [0, 8], name: '♭6 interval', fullName: 'Minor 6th' },
  { intervals: [0, 9], name: '6 interval', fullName: 'Major 6th' },
  { intervals: [0, 10], name: '♭7 interval', fullName: 'Minor 7th' },
  { intervals: [0, 11], name: '7 interval', fullName: 'Major 7th' },
];

// Identify chord from MIDI notes
function identifyChord(midiNotes) {
  if (midiNotes.length === 0) {
    return { root: '', name: '', fullName: '', intervals: [] };
  }
  
  if (midiNotes.length === 1) {
    const root = midiToNoteName(midiNotes[0]);
    return { root, name: '', fullName: 'Single Note', intervals: [0] };
  }
  
  const sortedNotes = [...midiNotes].sort((a, b) => a - b);
  const root = midiToNoteName(sortedNotes[0]);
  const intervals = getIntervalsFromRoot(midiNotes);
  
  // Try to match against known patterns
  for (const pattern of CHORD_PATTERNS) {
    if (arraysEqual(intervals, pattern.intervals)) {
      return {
        root,
        name: pattern.name,
        fullName: pattern.fullName,
        intervals
      };
    }
  }
  
  // Unknown chord - just show intervals
  const intervalNames = intervals.map(i => getIntervalName(i)).join(', ');
  return {
    root,
    name: '?',
    fullName: `Unknown (${intervalNames})`,
    intervals
  };
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function getIntervalName(semitones) {
  const names = {
    0: 'R', 1: '♭2', 2: '2', 3: '♭3', 4: '3',
    5: '4', 6: '♭5', 7: '5', 8: '♭6', 9: '6',
    10: '♭7', 11: '7'
  };
  return names[semitones] || semitones.toString();
}

// ─── GUITAR FINGERING ───
// Shared by the Chord Voicings page and Breaking the Loop. This is the model of
// what a hand can actually hold, and it is the reason a shape search returns
// chords rather than note sets: a combination of frets that is theoretically
// correct and needs five fingers, or that hides an open string under a barre,
// is not a voicing. Returns null when no hand can play it.
  // Finger numbers. Notes are taken lowest fret first, low string to high,
  // which is how most hands end up: 1-2-3 for D, 2-3-1 as a barre for F.
  // A barre is the lowest fret held on two or more strings with nothing
  // open between them; a "mini barre" is one finger flattening a group of
  // neighbouring strings at a higher fret (the A-shape's ring finger).
  function assignFingers(frets, sounding) {
    const fingers = new Array(6).fill(0);
    const fretted = sounding.filter(s => frets[s] > 0);
    if (!fretted.length) return { fingers, count: 0, barre: null, miniBarre: null };
    const minF = Math.min(...fretted.map(s => frets[s]));
    const atMin = fretted.filter(s => frets[s] === minF);
    let barre = null;
    // Barre only when the hand needs it: three or more strings at the lowest
    // fret, or too many notes for four separate fingers. An open D is three
    // fingers, not a barre, even though its index could lie flat.
    const adjacent = atMin.every((s, i) => i === 0 || s === atMin[i - 1] + 1);
    if (atMin.length >= 3 || (atMin.length >= 2 && (adjacent || fretted.length > 4))) {
      const lo = atMin[0], hi = sounding[sounding.length - 1];
      let ok = true;
      for (let s = lo; s <= hi; s++) if (frets[s] < minF) ok = false;
      if (ok) barre = { fret: minF, from: lo, to: hi };
    }
    let next = 1;
    const rest = [];
    if (barre) { atMin.forEach(s => { fingers[s] = 1; }); next = 2; fretted.forEach(s => { if (frets[s] !== minF) rest.push(s); }); }
    else fretted.forEach(s => rest.push(s));
    rest.sort((a, b) => frets[a] - frets[b] || a - b);
    let miniBarre = null;
    if (rest.length + next - 1 > 4) {
      // Too many notes for the fingers left: try flattening the highest
      // fret's neighbouring strings under one finger.
      const topF = Math.max(...rest.map(s => frets[s]));
      const top = rest.filter(s => frets[s] === topF);
      const contiguous = top.every((s, i) => i === 0 || s === top[i - 1] + 1);
      if (top.length >= 2 && contiguous && rest.length - top.length + 1 + next - 1 <= 4) {
        const lower = rest.filter(s => frets[s] !== topF);
        lower.forEach(s => { fingers[s] = next++; });
        top.forEach(s => { fingers[s] = next; });
        miniBarre = { fret: topF, from: top[0], to: top[top.length - 1], finger: next };
        next++;
        return { fingers, count: next - 1, barre, miniBarre };
      }
      return null;
    }
    rest.forEach(s => { fingers[s] = next++; });
    return { fingers, count: next - 1, barre, miniBarre };
  }

// Export for use in synth
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { identifyChord, midiToNoteName, getIntervalsFromRoot, getIntervalName, assignFingers };
}
