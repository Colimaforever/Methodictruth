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

// Export for use in synth
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { identifyChord, midiToNoteName, getIntervalsFromRoot, getIntervalName };
}
