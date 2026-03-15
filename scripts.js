// ─── MUSIC PLAYER ───
const playlist = [
  { title: 'Moqaddameh: Tchekad', src: 'audio/moqaddameh-tchekad.mp3' },
  { title: 'Masked Ball · Jocelyn Pook', src: 'audio/eyes-wide-shut-ritual.mp3' },
];

const audio = new Audio();
let currentTrack = 0;
let isPlaying = false;
let currentVolume = 0.4;

// Detect if audio.volume is writable (iOS makes it read-only)
let volumeWritable = true;
try {
  const testAudio = new Audio();
  testAudio.volume = 0.5;
  if (testAudio.volume !== 0.5) volumeWritable = false;
} catch(e) { volumeWritable = false; }

// Web Audio gain node — only used when audio.volume is read-only (iOS)
let audioCtx = null;
let audioGain = null;
let audioSourceNode = null;

function ensureAudioGain() {
  if (audioCtx || volumeWritable) return; // don't need it if audio.volume works
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioGain = audioCtx.createGain();
    audioSourceNode = audioCtx.createMediaElementSource(audio);
    audioSourceNode.connect(audioGain);
    audioGain.connect(audioCtx.destination);
    audioGain.gain.value = currentVolume;
    console.log('[Vol] iOS gain node active, vol:', currentVolume);
  } catch (e) {
    console.warn('[Vol] gain node failed:', e);
    audioCtx = null; audioGain = null;
  }
}

const playBtn = document.getElementById('playBtn');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const trackName = document.getElementById('trackName');
const playerStatus = document.getElementById('playerStatus');
const musicPlayer = document.getElementById('musicPlayer');
const volumeSlider = document.getElementById('volumeSlider');

// Restore state from localStorage — only volume, always start fresh with generative engine
const saved = JSON.parse(localStorage.getItem('musicState') || 'null');
currentTrack = 0;
if (saved && saved.volume != null && saved.volume >= 0 && saved.volume <= 1) {
  currentVolume = saved.volume;
  try { audio.volume = currentVolume; } catch(e) {}
  if (volumeSlider) volumeSlider.value = currentVolume * 100;
} else {
  currentVolume = 0.4;
  audio.volume = 0.4;
}
audio.loop = false;

// Save state continuously so it's always fresh
function saveMusicState() {
  localStorage.setItem('musicState', JSON.stringify({
    track: currentTrack,
    time: audio.currentTime,
    playing: isPlaying,
    volume: currentVolume,
    generative: genActive,
    maqamIndex: currentMaqamIndex,
    ts: Date.now()
  }));
}

// Save on every timeupdate (~4x per second while playing)
audio.addEventListener('timeupdate', saveMusicState);
// Also save on pause, play, and before unload
audio.addEventListener('pause', saveMusicState);
audio.addEventListener('play', saveMusicState);
window.addEventListener('beforeunload', saveMusicState);
// iOS: pagehide fires more reliably than beforeunload
window.addEventListener('pagehide', saveMusicState);
// iOS: visibilitychange as another safety net
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveMusicState(); });

// Save state when clicking nav links
document.querySelectorAll('.site-nav a').forEach(link => {
  link.addEventListener('click', saveMusicState);
});

function loadTrack(index) {
  if (playlist.length === 0) return;
  currentTrack = ((index % playlist.length) + playlist.length) % playlist.length;
  audio.src = playlist[currentTrack].src;
  trackName.textContent = playlist[currentTrack].title;
}

function setPlayingUI() {
  isPlaying = true;
  playBtn.textContent = '❚❚';
  playerStatus.textContent = '◈ playing';
  musicPlayer.classList.add('playing');
}

function startPlaying(seekTo) {
  if (playlist.length === 0) return;
  if (!audio.src) loadTrack(currentTrack);
  // iOS: ensure Web Audio gain node exists (needs user gesture to unlock AudioContext)
  if (!volumeWritable) {
    ensureAudioGain();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }

  function seekAndPlay() {
    if (seekTo != null) audio.currentTime = seekTo;
    audio.play().then(() => { setPlayingUI(); }).catch(() => {
      playerStatus.textContent = '◇ click to play';
      document.addEventListener('click', function resume() {
        if (seekTo != null) audio.currentTime = seekTo;
        audio.play().then(() => { setPlayingUI(); });
        document.removeEventListener('click', resume);
      }, { once: true });
    });
  }

  // Wait for audio to be ready before seeking
  if (seekTo != null && audio.readyState < 1) {
    audio.addEventListener('loadedmetadata', seekAndPlay, { once: true });
  } else {
    seekAndPlay();
  }
}

// togglePlay defined below (after generative engine code)
// playBtn listener also below
prevBtn.addEventListener('click', handlePrev);
nextBtn.addEventListener('click', handleNext);
volumeSlider.addEventListener('input', handleVolume);
audio.addEventListener('ended', handleTrackEnded);

// ─── GENERATIVE MAQAM ENGINE ───
const maqamScales = [
  { name: 'Hijaz',     notes: [0, 1, 4, 5, 7, 8, 10],   detune: [0, 0, 0, 0, 0, 0, 0] },
  { name: 'Rast',      notes: [0, 2, 3, 5, 7, 9, 10],    detune: [0, 0, 50, 0, 0, 0, 50] },
  { name: 'Bayati',    notes: [0, 1, 3, 5, 7, 8, 10],    detune: [0, 50, 0, 0, 0, 0, 0] },
  { name: 'Chahargah', notes: [0, 2, 3, 6, 7, 8, 11],    detune: [0, 0, 0, 0, 0, 0, 0] },
];

let genEngine = null; // holds the running generative engine state
let genActive = false;
let userPaused = false; // tracks if user explicitly paused — prevents auto-resume on interaction
let currentMaqamIndex = 0;

function loadToneJS() {
  return new Promise((resolve, reject) => {
    if (window.Tone) return resolve();
    const s = document.createElement('script');
    s.src = 'lib/tone.min.js';
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function maqamFreq(scale, degree, octave) {
  const semitone = scale.notes[((degree % scale.notes.length) + scale.notes.length) % scale.notes.length];
  const oct = octave + Math.floor(degree / scale.notes.length);
  const cents = scale.detune[((degree % scale.notes.length) + scale.notes.length) % scale.notes.length] || 0;
  const base = 440 * Math.pow(2, (semitone - 9) / 12 + (oct - 4));
  return base * Math.pow(2, cents / 1200);
}

function handleTrackEnded() {
  // Auto-advance to next track in playlist
  currentTrack++;
  if (currentTrack >= playlist.length) {
    currentTrack = 0; // Loop back to start of playlist
  }
  loadTrack(currentTrack);
  startPlaying();
}

function handlePrev() {
  if (genActive) {
    if (currentMaqamIndex > 0) {
      currentMaqamIndex--;
      if (genEngine) switchMaqam(currentMaqamIndex);
    } else {
      // Back to Tchekad
      stopGenerativeEngine();
      loadTrack(0);
      startPlaying();
    }
  } else if (currentTrack === playlist.length - 1) {
    // From Sudden Truths, go back to generative
    startGenerativeEngine();
  } else {
    loadTrack(currentTrack - 1);
    if (isPlaying) audio.play();
  }
}

function handleNext() {
  if (genActive) {
    if (currentMaqamIndex < maqamScales.length - 1) {
      currentMaqamIndex++;
      if (genEngine) switchMaqam(currentMaqamIndex);
    } else {
      // Done with generative — play Sudden Truths (last track)
      stopGenerativeEngine();
      loadTrack(playlist.length - 1);
      startPlaying();
    }
  } else if (currentTrack === 0) {
    // After Tchekad, go to generative
    startGenerativeEngine();
  } else {
    // After Sudden Truths, loop back
    loadTrack(0);
    if (isPlaying) startPlaying();
  }
}

let volumeRafId = null;
function handleVolume(e) {
  const vol = e.target.value / 100;
  currentVolume = vol;
  if (volumeWritable) {
    audio.volume = vol;
  } else {
    ensureAudioGain();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    if (audioGain) {
      try {
        audioGain.gain.cancelScheduledValues(audioCtx.currentTime);
        audioGain.gain.setValueAtTime(vol, audioCtx.currentTime);
      } catch(err) { audioGain.gain.value = vol; }
    }
  }
  // Generative engine volume (Tone.js)
  if (genEngine && genEngine.masterGain) {
    try {
      // Cancel any ongoing ramps (like the 5s startup fade) then set immediately
      const g = genEngine.masterGain.gain;
      if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(Tone.now());
      else if (g.cancelScheduledValues) g.cancelScheduledValues(Tone.now());
      g.value = vol;
    } catch(e) {
      console.warn('[Vol] genEngine set failed:', e);
    }
  }
}

async function togglePlay() {
  if (genActive) {
    if (isPlaying) {
      userPaused = true;
      pauseGenerativeEngine();
    } else {
      userPaused = false;
      resumeGenerativeEngine();
    }
    return;
  }
  // If nothing is active yet, always start with generative engine
  if (!isPlaying && !genActive) {
    userPaused = false;
    engineStarting = true;
    await startGenerativeEngine();
    engineStarting = false;
    return;
  }
  if (isPlaying) {
    userPaused = true;
    audio.pause();
    isPlaying = false;
    playBtn.textContent = '▷';
    playerStatus.textContent = '◇ paused';
    musicPlayer.classList.remove('playing');
  } else {
    userPaused = false;
    startPlaying();
  }
}
playBtn.addEventListener('click', togglePlay);

async function startGenerativeEngine() {
  if (genActive) return; // prevent double-start
  audio.pause();
  audio.currentTime = 0;
  
  try {
    await loadToneJS();
  } catch(e) {
    console.error('[Gen] Failed to load Tone.js:', e);
    return;
  }
  try {
    await Tone.start();
    // Ensure AudioContext is running (critical for iOS)
    if (Tone.context.state === 'suspended') await Tone.context.resume();
    // Double-check it actually started
    if (Tone.context.state !== 'running') {
      console.warn('[Gen] AudioContext state:', Tone.context.state, '— waiting for next interaction');
      return;
    }
  } catch(e) {
    console.error('[Gen] Tone.start() failed:', e);
    return;
  }
  
  genActive = true;
  const scale = maqamScales[currentMaqamIndex];
  trackName.textContent = 'Generative · Maqam ' + scale.name;
  playerStatus.textContent = '◈ generating';
  setPlayingUI();

  const eng = {};
  genEngine = eng;

  // Master chain
  eng.masterGain = new Tone.Gain(currentVolume).toDestination();
  eng.analyser = new Tone.Waveform(256);
  eng.masterGain.connect(eng.analyser);
  eng.compressor = new Tone.Compressor(-20, 4).connect(eng.masterGain);
  eng.reverb = new Tone.Reverb({ decay: 8, wet: 0.7 });
  await eng.reverb.generate();
  eng.reverb.connect(eng.compressor);

  // Drone layer - 2 FMSynths
  eng.drones = [];
  for (let i = 0; i < 2; i++) {
    const drone = new Tone.FMSynth({
      harmonicity: 1.5,
      modulationIndex: 0.5,
      envelope: { attack: 4, decay: 0, sustain: 1, release: 5 },
      modulation: { type: 'sine' },
      oscillator: { type: 'sine' }
    }).connect(eng.reverb);
    drone.volume.value = -18;
    eng.drones.push(drone);
  }
  // Start drones
  const droneFreqs = [maqamFreq(scale, 0, 2), maqamFreq(scale, 4, 2)];
  eng.drones[0].triggerAttack(droneFreqs[0]);
  eng.drones[1].triggerAttack(droneFreqs[1]);

  // Drone microtonal drift LFOs
  eng.droneLFOs = eng.drones.map((d, i) => {
    const lfo = new Tone.LFO({ frequency: 0.03 + i * 0.01, min: -10, max: 10, type: 'sine' }).start();
    lfo.connect(d.detune);
    return lfo;
  });

  // ─── STRING PAD LAYER ─── slow evolving maqam chords
  eng.stringPad = new Tone.PolySynth(Tone.FMSynth, {
    maxPolyphony: 4,
    voice: {
      harmonicity: 2,
      modulationIndex: 0.3,
      envelope: { attack: 6, decay: 2, sustain: 0.7, release: 8 },
      modulation: { type: 'triangle' },
      oscillator: { type: 'sawtooth4' }
    }
  }).connect(eng.reverb);
  eng.stringPad.volume.value = -24;

  // String pad chord changes — every 20s, play 2-3 notes from scale
  eng.stringLoop = setInterval(() => {
    if (!genActive || !eng.stringPad) return;
    const s = eng.currentScale;
    eng.stringPad.releaseAll();
    const numNotes = 2 + Math.floor(Math.random() * 2); // 2-3 notes
    const degrees = [];
    while (degrees.length < numNotes) {
      const d = Math.floor(Math.random() * s.notes.length);
      if (!degrees.includes(d)) degrees.push(d);
    }
    const freqs = degrees.map(d => maqamFreq(s, d, 2 + Math.floor(Math.random() * 2)));
    const dur = 14 + Math.random() * 6;
    freqs.forEach(f => eng.stringPad.triggerAttackRelease(f, dur));
  }, 20000);

  // ─── MELODIC PLUCK LAYER ─── sparse contemplative single notes
  eng.pluck = new Tone.PluckSynth({
    attackNoise: 1,
    dampening: 2000,
    resonance: 0.98
  }).connect(eng.reverb);
  eng.pluck.volume.value = -22;

  eng.pluckLoop = setInterval(() => {
    if (!genActive || !eng.pluck) return;
    if (Math.random() > 0.5) return; // 50% chance to skip — keeps it sparse and contemplative
    const s = eng.currentScale;
    const degree = Math.floor(Math.random() * s.notes.length);
    const octave = 3 + Math.floor(Math.random() * 2);
    eng.pluck.triggerAttack(maqamFreq(s, degree, octave));
  }, 7000);

  // ─── CELLO DRONE ─── deep sustained low register
  eng.celloDrone = new Tone.FMSynth({
    harmonicity: 1,
    modulationIndex: 0.2,
    envelope: { attack: 6, decay: 0, sustain: 1, release: 8 },
    modulation: { type: 'sine' },
    oscillator: { type: 'sawtooth4' }
  }).connect(eng.reverb);
  eng.celloDrone.volume.value = -26;
  eng.celloDrone.triggerAttack(maqamFreq(scale, 0, 1)); // root, one octave below drones

  eng.celloLFO = new Tone.LFO({ frequency: 0.02, min: -8, max: 8, type: 'sine' }).start();
  eng.celloLFO.connect(eng.celloDrone.detune);

  // ─── SHIMMER LAYER ─── high harmonics fading in/out
  eng.shimmer = new Tone.FMSynth({
    harmonicity: 3,
    modulationIndex: 1,
    envelope: { attack: 5, decay: 3, sustain: 0.3, release: 6 },
    modulation: { type: 'sine' },
    oscillator: { type: 'sine' }
  }).connect(eng.reverb);
  eng.shimmer.volume.value = -30;

  eng.shimmerLoop = setInterval(() => {
    if (!genActive || !eng.shimmer) return;
    if (Math.random() > 0.45) return; // ~45% chance — rare, ethereal
    const s = eng.currentScale;
    const degree = Math.floor(Math.random() * s.notes.length);
    const freq = maqamFreq(s, degree, 4 + Math.floor(Math.random() * 2));
    eng.shimmer.triggerAttackRelease(freq, 10 + Math.random() * 5);
  }, 15000);

  // Texture layer - filtered noise
  eng.noise = new Tone.Noise('brown').start();
  eng.noise.volume.value = -35;
  eng.noiseFilter = new Tone.AutoFilter({ frequency: 0.05, baseFrequency: 200, octaves: 3, wet: 1 }).connect(eng.reverb).start();
  eng.noise.connect(eng.noiseFilter);

  eng.currentScale = scale;

  // Maqam rotation every 3 min
  eng.maqamRotation = setInterval(() => {
    if (!genActive) return;
    currentMaqamIndex = (currentMaqamIndex + 1) % maqamScales.length;
    switchMaqam(currentMaqamIndex);
  }, 180000);

  // Fade in
  eng.masterGain.gain.value = 0;
  eng.masterGain.gain.rampTo(currentVolume || 0.4, 5);

  Tone.Transport.start();
  if (bgOsc && !bgOscCtx) { bgOscCtx = bgOsc.getContext('2d'); resizeBgOsc(); drawBgOscilloscope(); }
}

function switchMaqam(index) {
  if (!genEngine) return;
  const scale = maqamScales[index];
  genEngine.currentScale = scale;
  trackName.textContent = 'Generative · Maqam ' + scale.name;

  // Glide drones to new pitches
  const newFreqs = [maqamFreq(scale, 0, 2), maqamFreq(scale, 4, 2)];
  genEngine.drones.forEach((d, i) => {
    d.frequency.rampTo(newFreqs[i], 12);
  });
  // Glide cello to new root
  if (genEngine.celloDrone) {
    genEngine.celloDrone.frequency.rampTo(maqamFreq(scale, 0, 1), 12);
  }
  // Release string pad so next chord uses new scale
  if (genEngine.stringPad) genEngine.stringPad.releaseAll();
}

function pauseGenerativeEngine() {
  if (!genEngine) return;
  Tone.Transport.pause();
  // Immediately silence — don't rely on slow ramp
  genEngine.drones.forEach(d => { d.volume.cancelScheduledValues(Tone.now()); d.volume.value = -Infinity; });
  if (genEngine.noise) { genEngine.noise.volume.cancelScheduledValues(Tone.now()); genEngine.noise.volume.value = -Infinity; }
  if (genEngine.stringPad) genEngine.stringPad.releaseAll();
  if (genEngine.shimmer) genEngine.shimmer.triggerRelease();
  if (genEngine.celloDrone) { genEngine.celloDrone.volume.cancelScheduledValues(Tone.now()); genEngine.celloDrone.volume.value = -Infinity; }
  if (genEngine.pluck) { genEngine.pluck.volume.cancelScheduledValues(Tone.now()); genEngine.pluck.volume.value = -Infinity; }
  isPlaying = false;
  playBtn.textContent = '▷';
  playerStatus.textContent = '◇ paused';
  musicPlayer.classList.remove('playing');
}

function resumeGenerativeEngine() {
  if (!genEngine) return;
  Tone.Transport.start();
  genEngine.drones.forEach(d => d.volume.rampTo(-18, 1));
  if (genEngine.noise) genEngine.noise.volume.rampTo(-35, 1);
  if (genEngine.celloDrone) genEngine.celloDrone.volume.rampTo(-26, 1);
  if (genEngine.pluck) genEngine.pluck.volume.rampTo(-22, 1);
  if (genEngine.stringPad) genEngine.stringPad.volume.rampTo(-24, 1);
  if (genEngine.shimmer) genEngine.shimmer.volume.rampTo(-30, 1);
  setPlayingUI();
  playerStatus.textContent = '◈ generating';
}

function stopGenerativeEngine() {
  if (!genEngine) return;
  if (genEngine.maqamRotation) clearInterval(genEngine.maqamRotation);
  if (genEngine.stringLoop) clearInterval(genEngine.stringLoop);
  if (genEngine.pluckLoop) clearInterval(genEngine.pluckLoop);
  if (genEngine.shimmerLoop) clearInterval(genEngine.shimmerLoop);
  Tone.Transport.stop();
  Tone.Transport.cancel();
  // Dispose all nodes
  ['drones', 'droneLFOs'].forEach(key => {
    if (genEngine[key]) genEngine[key].forEach(n => n.dispose());
  });
  ['stringPad', 'pluck', 'celloDrone', 'celloLFO', 'shimmer', 'noise', 'noiseFilter', 'reverb', 'compressor', 'masterGain'].forEach(key => {
    if (genEngine[key]) genEngine[key].dispose();
  });
  if (genEngine.analyser) genEngine.analyser.dispose();
  genEngine = null;
  genActive = false;
}

// ─── UNIFIED STARTUP: wait for user interaction on ALL platforms ───
// This ensures iOS and desktop behave identically — no broken auto-start.
let hasInteracted = false;
let engineStarting = false;

async function onFirstInteraction() {
  if (hasInteracted) return;
  hasInteracted = true;
  // Remove all listeners
  ['touchstart', 'click', 'scroll', 'keydown'].forEach(evt => {
    document.removeEventListener(evt, onFirstInteraction, true);
  });
  // Resume any suspended audio contexts
  if (!volumeWritable) ensureAudioGain();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  if (bgAudioCtx && bgAudioCtx.state === 'suspended') bgAudioCtx.resume();
  // Start generative engine on first interaction (consistent across all platforms)
  if (!isPlaying && !userPaused && !genActive && !engineStarting) {
    engineStarting = true;
    await startGenerativeEngine();
    engineStarting = false;
  }
}
['touchstart', 'click', 'scroll', 'keydown'].forEach(evt => {
  document.addEventListener(evt, onFirstInteraction, { capture: true, once: false, passive: true });
});

// ─── BACKGROUND OSCILLOSCOPE ───
const bgOsc = document.getElementById('bgOscilloscope');
let bgOscCtx, bgAnalyser, bgAudioCtx, bgAudioSource, bgOscConnected = false;

function resizeBgOsc() {
  if (!bgOsc) return;
  bgOsc.width = window.innerWidth;
  bgOsc.height = Math.floor(window.innerHeight * 0.3);
}
if (bgOsc) {
  resizeBgOsc();
  window.addEventListener('resize', resizeBgOsc);
}

function initBgOscilloscope() {
  if (bgOscConnected || !bgOsc) return;
  bgOscCtx = bgOsc.getContext('2d');
  bgAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  bgAnalyser = bgAudioCtx.createAnalyser();
  bgAnalyser.fftSize = 512;
  bgAnalyser.smoothingTimeConstant = 0.85;
  bgAudioSource = bgAudioCtx.createMediaElementSource(audio);
  bgAudioSource.connect(bgAnalyser);
  bgAnalyser.connect(bgAudioCtx.destination);
  bgOscConnected = true;
  drawBgOscilloscope();
}

function drawBgOscilloscope() {
  if (!bgOsc) return;
  requestAnimationFrame(drawBgOscilloscope);
  const ctx = bgOscCtx;
  const w = bgOsc.width;
  const h = bgOsc.height;
  ctx.clearRect(0, 0, w, h);

  let dataArray, color1, color2;

  if (genActive && genEngine && genEngine.analyser) {
    dataArray = genEngine.analyser.getValue();
    color1 = 'rgba(138, 43, 226, 0.6)';
    color2 = 'rgba(138, 43, 226, 0.15)';
  } else if (bgAnalyser && bgOscConnected) {
    dataArray = new Float32Array(bgAnalyser.frequencyBinCount);
    bgAnalyser.getFloatTimeDomainData(dataArray);
    color1 = 'rgba(0, 229, 255, 0.6)';
    color2 = 'rgba(0, 229, 255, 0.15)';
  } else {
    return;
  }

  // Fill gradient beneath waveform
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, color2);
  gradient.addColorStop(1, 'transparent');

  // Main waveform
  ctx.beginPath();
  const sliceWidth = w / dataArray.length;
  let x = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const v = dataArray[i];
    const y = (1 - v) * h / 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    x += sliceWidth;
  }

  // Fill beneath
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Stroke the waveform line
  ctx.beginPath();
  x = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const v = dataArray[i];
    const y = (1 - v) * h / 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    x += sliceWidth;
  }
  ctx.strokeStyle = color1;
  ctx.lineWidth = 2;
  ctx.shadowColor = color1;
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

// Hook into play events to init oscilloscope
const origStartPlaying = startPlaying;
startPlaying = function(seekTo) {
  initBgOscilloscope();
  if (bgAudioCtx && bgAudioCtx.state === 'suspended') bgAudioCtx.resume();
  return origStartPlaying(seekTo);
};

// ─── STARFIELD RENDERER ───
const _starCanvas = document.getElementById('stars');
const _starCtx = _starCanvas ? _starCanvas.getContext('2d') : null;
let stars = [];

function resize() {
  if (!_starCanvas) return;
  _starCanvas.width = window.innerWidth;
  _starCanvas.height = window.innerHeight;
  initStars();
}

function initStars() {
  stars = [];
  const count = Math.floor((_starCanvas.width * _starCanvas.height) / 2000);
  for (let i = 0; i < count; i++) {
    stars.push({
      x: Math.random() * _starCanvas.width,
      y: Math.random() * _starCanvas.height,
      size: Math.random() * 1.5 + 0.3,
      opacity: Math.random() * 0.8 + 0.2,
      twinkleSpeed: Math.random() * 0.02 + 0.005,
      twinkleOffset: Math.random() * Math.PI * 2,
      warm: Math.random() > 0.92,
      blue: Math.random() > 0.95
    });
  }
}

function drawStars(time) {
  if (!_starCanvas || !_starCtx) return;
  if (document.hidden) { requestAnimationFrame(drawStars); return; }
  _starCtx.clearRect(0, 0, _starCanvas.width, _starCanvas.height);
  
  stars.forEach(star => {
    const twinkle = Math.sin(time * star.twinkleSpeed + star.twinkleOffset);
    const opacity = star.opacity * (0.6 + twinkle * 0.4);
    
    if (star.warm) {
      _starCtx.fillStyle = `rgba(232, 168, 124, ${opacity})`;
    } else if (star.blue) {
      _starCtx.fillStyle = `rgba(140, 180, 255, ${opacity})`;
    } else {
      _starCtx.fillStyle = `rgba(240, 232, 216, ${opacity})`;
    }
    
    _starCtx.beginPath();
    _starCtx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
    _starCtx.fill();
    
    if (star.size > 1.2) {
      _starCtx.fillStyle = `rgba(240, 232, 216, ${opacity * 0.15})`;
      _starCtx.beginPath();
      _starCtx.arc(star.x, star.y, star.size * 3, 0, Math.PI * 2);
      _starCtx.fill();
    }
  });

  requestAnimationFrame(drawStars);
}

if (_starCanvas && _starCtx) {
  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(drawStars);
}

// ─── MOBILE NAV TOGGLE ───
(function() {
  const navToggle = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');
  if (!navToggle || !navLinks) return;
  navToggle.addEventListener('click', () => {
    navLinks.classList.toggle('open');
    navToggle.textContent = navLinks.classList.contains('open') ? '✕' : '☰';
  });
  // Close nav when a link is clicked (use event delegation so it works for all links)
  navLinks.addEventListener('click', (e) => {
    if (e.target.closest('a')) {
      navLinks.classList.remove('open');
      navToggle.textContent = '☰';
      // Also close any open dropdowns
      navLinks.querySelectorAll('.nav-dropdown.open').forEach(d => d.classList.remove('open'));
    }
  });
  // Dropdown toggle on mobile (tap)
  navLinks.querySelectorAll('.nav-drop-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dropdown = btn.closest('.nav-dropdown');
      // Close other dropdowns
      navLinks.querySelectorAll('.nav-dropdown.open').forEach(d => {
        if (d !== dropdown) d.classList.remove('open');
      });
      dropdown.classList.toggle('open');
    });
  });
})();

// ─── SPA ROUTER — Keep audio alive across navigation ───
(function() {
  const INTERNAL_PAGES = ['index.html', 'chronicles.html', 'philosophy.html', 'about.html', 'stack.html', 'live.html', 'guestbook.html', 'synth.html', 'mixer.html', 'tuner.html', 'theory.html', 'signal.html', 'architecture.html', 'topology.html', 'songwriter.html', 'tapbpm.html', 'feedback.html', 'vault.html', 'studio.html', 'guitar.html'];

  function isInternalLink(href) {
    try {
      const url = new URL(href, window.location.origin);
      if (url.origin !== window.location.origin) return false;
      const path = url.pathname.split('/').pop() || 'index.html';
      return INTERNAL_PAGES.includes(path);
    } catch { return false; }
  }

  function getPageName(href) {
    try {
      const url = new URL(href, window.location.origin);
      return url.pathname.split('/').pop() || 'index.html';
    } catch { return null; }
  }

  async function navigateTo(href, pushState) {
    saveMusicState();
    const pageName = getPageName(href);
    if (!pageName) return;

    try {
      const resp = await fetch(href, { cache: 'no-cache' });
      if (!resp.ok) { window.location.href = href; return; }
      const html = await resp.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      // Swap title
      document.title = doc.title;

      // Swap page-specific styles: remove old page styles, inject new ones
      document.querySelectorAll('style[data-spa-page]').forEach(s => s.remove());
      doc.querySelectorAll('head style').forEach(s => {
        const clone = s.cloneNode(true);
        clone.setAttribute('data-spa-page', pageName);
        document.head.appendChild(clone);
      });

      // Swap page content: everything between nav and persistent elements
      // Persistent = starfield, nebula, ground, nav, music player, bgOscilloscope, scripts
      const KEEP = new Set(['SCRIPT', 'CANVAS']);
      const keepSelectors = '.starfield, .nebula, .ground, .site-nav, #musicPlayer, #bgOscilloscope';

      // Remove old page content
      Array.from(document.body.children).forEach(el => {
        if (KEEP.has(el.tagName)) return;
        if (el.matches && el.matches(keepSelectors)) return;
        el.remove();
      });

      // Force-remove structures-svg on pages that don't want it
      const noStructures = ['architecture.html'];
      if (noStructures.includes(pageName)) {
        document.querySelectorAll('.structures-svg').forEach(el => el.remove());
      }

      // Insert new page content (everything from parsed doc that isn't persistent)
      const nav = document.querySelector('.site-nav');
      const frag = document.createDocumentFragment();
      Array.from(doc.body.children).forEach(el => {
        if (KEEP.has(el.tagName)) return;
        if (el.matches && el.matches(keepSelectors)) return;
        frag.appendChild(el.cloneNode(true));
      });
      // Insert after nav
      if (nav && nav.nextSibling) {
        nav.parentNode.insertBefore(frag, nav.nextSibling);
      } else {
        document.body.appendChild(frag);
      }

      // Update active nav link
      document.querySelectorAll('.site-nav a').forEach(a => {
        const linkPage = getPageName(a.href);
        a.classList.toggle('active', linkPage === pageName);
      });

      // Hide/show decorative layers per page
      const hideDecor = ['architecture.html'];
      const isClean = hideDecor.includes(pageName);
      ['.nebula', '.ground', '.starfield', '.sky-glyph', '.artifact-float', '.shooting-star', '.structures-svg'].forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          if (isClean) { el.style.display = 'none'; el.style.visibility = 'hidden'; }
          else { el.style.display = ''; el.style.visibility = ''; }
        });
      });
      document.body.classList.toggle('no-grain', isClean);

      // Hide music player on tool pages where it overlaps the UI
      const toolPages = ['synth.html', 'mixer.html', 'signal.html', 'tuner.html', 'tapbpm.html', 'guitar.html', 'songwriter.html', 'live.html'];
      const mp = document.getElementById('musicPlayer');
      if (mp) {
        if (toolPages.includes(pageName)) {
          mp.style.display = 'none';
        } else {
          mp.style.display = '';
        }
      }

      // Execute page-specific inline scripts from new page
      // Find ALL inline scripts (no src) except ones we've already loaded globally
      const skipSrc = ['scripts.js', 'tone.min.js', 'firebase-app-compat.js', 'firebase-database-compat.js', 'peerjs.min.js'];
      doc.querySelectorAll('script').forEach(s => {
        if (s.src && skipSrc.some(lib => s.src.includes(lib))) return;
        if (s.src) {
          // Load external page-specific scripts dynamically
          const existing = document.querySelector(`script[src="${new URL(s.src, href).pathname}"]`);
          if (!existing) {
            const ns = document.createElement('script');
            ns.src = s.src;
            document.body.appendChild(ns);
          }
          return;
        }
        try {
          const fn = new Function(s.textContent);
          fn();
        } catch (e) { console.warn('SPA script exec:', e); }
      });

      // Re-bind SPA nav links on new content
      bindNavLinks();

      // Push state
      if (pushState !== false) {
        history.pushState({ page: pageName }, '', href);
      }

      // Close mobile nav if open
      const navL = document.getElementById('navLinks');
      const navT = document.getElementById('navToggle');
      if (navL) navL.classList.remove('open');
      if (navT) navT.textContent = '☰';
      // Close any open dropdowns
      document.querySelectorAll('.nav-dropdown.open').forEach(d => d.classList.remove('open'));

      // Scroll to top
      window.scrollTo(0, 0);

    } catch (err) {
      console.warn('SPA nav failed, falling back:', err);
      window.location.href = href;
    }
  }

  function bindNavLinks() {
    document.querySelectorAll('a[href]').forEach(link => {
      if (link.dataset.spabound) return;
      if (!isInternalLink(link.href)) return;
      link.dataset.spabound = '1';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        navigateTo(link.href, true);
      });
    });
  }

  // Handle back/forward
  window.addEventListener('popstate', (e) => {
    navigateTo(window.location.href, false);
  });

  // Initial bind
  bindNavLinks();

  // Set initial history state
  history.replaceState({ page: getPageName(window.location.href) }, '', window.location.href);

  // ⌇
  let _vt=[],_vh=function(e){var r=e.target.closest('.roots')||e.target.closest('#vaultDoor');if(r){_vt.push(Date.now());_vt=_vt.filter(function(t){return Date.now()-t<2000});if(_vt.length>=3){_vt=[];window.location.href='/vault'}}};document.addEventListener('click',_vh);document.addEventListener('touchend',function(e){var r=e.target.closest('.roots')||e.target.closest('#vaultDoor');if(r){e.preventDefault();_vh(e)}},{passive:false});
})();
