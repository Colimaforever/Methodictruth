// ─── MUSIC PLAYER ───
const playlist = [
  { title: 'Sudden Truths', src: 'audio/sudden-truths.mp3' },
];

const audio = new Audio();
let currentTrack = 0;
let isPlaying = false;

const playBtn = document.getElementById('playBtn');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const trackName = document.getElementById('trackName');
const playerStatus = document.getElementById('playerStatus');
const musicPlayer = document.getElementById('musicPlayer');
const volumeSlider = document.getElementById('volumeSlider');

// Restore state from localStorage
const saved = JSON.parse(localStorage.getItem('musicState') || 'null');
if (saved) {
  currentTrack = saved.track || 0;
  audio.volume = saved.volume != null ? saved.volume : 0.4;
  volumeSlider.value = audio.volume * 100;
} else {
  audio.volume = 0.4;
}
audio.loop = false;

// Save state continuously so it's always fresh
function saveMusicState() {
  localStorage.setItem('musicState', JSON.stringify({
    track: currentTrack,
    time: audio.currentTime,
    playing: isPlaying,
    volume: audio.volume,
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

function togglePlay() {
  if (playlist.length === 0) {
    trackName.textContent = 'Drop mp3s in /audio';
    return;
  }
  if (isPlaying) {
    audio.pause();
    isPlaying = false;
    playBtn.textContent = '▷';
    playerStatus.textContent = '◇ paused';
    musicPlayer.classList.remove('playing');
  } else {
    startPlaying();
  }
}

playBtn.addEventListener('click', togglePlay);
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
  // Instead of looping, start generative engine
  startGenerativeEngine();
}

function handlePrev() {
  if (genActive) {
    if (currentMaqamIndex > 0) {
      currentMaqamIndex--;
      if (genEngine) switchMaqam(currentMaqamIndex);
    } else {
      stopGenerativeEngine();
      loadTrack(0);
      startPlaying();
    }
  } else {
    loadTrack(currentTrack - 1);
    if (isPlaying) audio.play();
  }
}

function handleNext() {
  if (genActive) {
    currentMaqamIndex = (currentMaqamIndex + 1) % maqamScales.length;
    if (genEngine) switchMaqam(currentMaqamIndex);
  } else if (!genActive && currentTrack === playlist.length - 1) {
    startGenerativeEngine();
  } else {
    loadTrack(currentTrack + 1);
    if (isPlaying) audio.play();
  }
}

function handleVolume(e) {
  const vol = e.target.value / 100;
  audio.volume = vol;
  if (genEngine && genEngine.masterGain) {
    genEngine.masterGain.gain.rampTo(vol, 0.1);
  }
}

function togglePlay() {
  if (playlist.length === 0 && !genActive) {
    trackName.textContent = 'Drop mp3s in /audio';
    return;
  }
  if (genActive) {
    if (isPlaying) {
      pauseGenerativeEngine();
    } else {
      resumeGenerativeEngine();
    }
    return;
  }
  if (isPlaying) {
    audio.pause();
    isPlaying = false;
    playBtn.textContent = '▷';
    playerStatus.textContent = '◇ paused';
    musicPlayer.classList.remove('playing');
  } else {
    startPlaying();
  }
}

async function startGenerativeEngine() {
  audio.pause();
  audio.currentTime = 0;
  
  await loadToneJS();
  await Tone.start();
  
  genActive = true;
  const scale = maqamScales[currentMaqamIndex];
  trackName.textContent = 'Generative · Maqam ' + scale.name;
  playerStatus.textContent = '◈ generating';
  setPlayingUI();

  const eng = {};
  genEngine = eng;

  // Master chain
  eng.masterGain = new Tone.Gain(audio.volume).toDestination();
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

  // Pad layer
  eng.pad = new Tone.PolySynth(Tone.FMSynth, {
    maxPolyphony: 4,
    harmonicity: 2,
    modulationIndex: 1,
    envelope: { attack: 6, decay: 2, sustain: 0.8, release: 8 },
    oscillator: { type: 'triangle' }
  }).connect(eng.reverb);
  eng.pad.volume.value = -22;

  // Shimmer layer
  eng.shimmer = new Tone.AMSynth({
    harmonicity: 3,
    envelope: { attack: 0.3, decay: 2, sustain: 0, release: 3 },
    oscillator: { type: 'sine' }
  }).connect(eng.reverb);
  eng.shimmer.volume.value = -28;

  // Texture layer - filtered noise
  eng.noise = new Tone.Noise('brown').start();
  eng.noise.volume.value = -35;
  eng.noiseFilter = new Tone.AutoFilter({ frequency: 0.05, baseFrequency: 200, octaves: 3, wet: 1 }).connect(eng.reverb).start();
  eng.noise.connect(eng.noiseFilter);

  // Schedule pad chord changes
  eng.currentScale = scale;
  eng.padLoop = new Tone.Loop((time) => {
    const s = eng.currentScale;
    const root = Math.floor(Math.random() * 3); // 0,1,2 degree
    const chord = [0, 2, 4].map(d => maqamFreq(s, root + d, 3));
    eng.pad.triggerAttackRelease(chord, '12s', time);
  }, 20);
  eng.padLoop.start(0);

  // Schedule shimmer notes
  eng.shimmerLoop = new Tone.Loop((time) => {
    const s = eng.currentScale;
    const deg = Math.floor(Math.random() * s.notes.length);
    const freq = maqamFreq(s, deg, 5 + Math.floor(Math.random() * 2));
    eng.shimmer.triggerAttackRelease(freq, '2s', time, 0.3 + Math.random() * 0.3);
  }, 5);
  eng.shimmerLoop.start(0);
  eng.shimmerLoop.humanize = '2s';

  // Maqam rotation every 2-5 min
  eng.maqamRotation = setInterval(() => {
    if (!genActive) return;
    currentMaqamIndex = (currentMaqamIndex + 1) % maqamScales.length;
    switchMaqam(currentMaqamIndex);
  }, (120 + Math.random() * 180) * 1000);

  // Fade in
  eng.masterGain.gain.value = 0;
  eng.masterGain.gain.rampTo(audio.volume || 0.4, 5);

  Tone.Transport.start();
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
}

function pauseGenerativeEngine() {
  if (!genEngine) return;
  Tone.Transport.pause();
  genEngine.drones.forEach(d => d.volume.rampTo(-Infinity, 1));
  genEngine.noise.volume.rampTo(-Infinity, 1);
  isPlaying = false;
  playBtn.textContent = '▷';
  playerStatus.textContent = '◇ paused';
  musicPlayer.classList.remove('playing');
}

function resumeGenerativeEngine() {
  if (!genEngine) return;
  Tone.Transport.start();
  genEngine.drones.forEach(d => d.volume.rampTo(-18, 1));
  genEngine.noise.volume.rampTo(-35, 1);
  setPlayingUI();
  playerStatus.textContent = '◈ generating';
}

function stopGenerativeEngine() {
  if (!genEngine) return;
  if (genEngine.maqamRotation) clearInterval(genEngine.maqamRotation);
  Tone.Transport.stop();
  Tone.Transport.cancel();
  // Dispose all nodes
  ['drones', 'droneLFOs'].forEach(key => {
    if (genEngine[key]) genEngine[key].forEach(n => n.dispose());
  });
  ['pad', 'shimmer', 'noise', 'noiseFilter', 'reverb', 'compressor', 'masterGain'].forEach(key => {
    if (genEngine[key]) genEngine[key].dispose();
  });
  if (genEngine.padLoop) genEngine.padLoop.dispose();
  if (genEngine.shimmerLoop) genEngine.shimmerLoop.dispose();
  genEngine = null;
  genActive = false;
}

// Initialize: restore from saved state or start fresh
if (saved && saved.generative && saved.playing) {
  // Was in generative mode — restore it
  const stateAge = saved.ts ? Date.now() - saved.ts : Infinity;
  if (stateAge < 30000) {
    currentMaqamIndex = saved.maqamIndex || 0;
    startGenerativeEngine();
  } else {
    // Stale — show resume prompt
    loadTrack(currentTrack);
    playerStatus.textContent = '◇ tap ▷ to resume';
  }
} else if (playlist.length > 0) {
  loadTrack(currentTrack);
  if (saved && saved.playing) {
    const stateAge = saved.ts ? Date.now() - saved.ts : Infinity;
    const seekTime = saved.time || 0;
    if (stateAge < 30000) {
      startPlaying(seekTime);
    } else {
      audio.src = playlist[currentTrack].src;
      audio.addEventListener('loadedmetadata', () => {
        audio.currentTime = seekTime;
      }, { once: true });
      playerStatus.textContent = '◇ tap ▷ to resume';
    }
  } else if (!saved) {
    startPlaying();
  }
}

// ─── STARFIELD RENDERER ───
const canvas = document.getElementById('stars');
const ctx = canvas.getContext('2d');
let stars = [];

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  initStars();
}

function initStars() {
  stars = [];
  const count = Math.floor((canvas.width * canvas.height) / 2000);
  for (let i = 0; i < count; i++) {
    stars.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
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
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  stars.forEach(star => {
    const twinkle = Math.sin(time * star.twinkleSpeed + star.twinkleOffset);
    const opacity = star.opacity * (0.6 + twinkle * 0.4);
    
    if (star.warm) {
      ctx.fillStyle = `rgba(232, 168, 124, ${opacity})`;
    } else if (star.blue) {
      ctx.fillStyle = `rgba(140, 180, 255, ${opacity})`;
    } else {
      ctx.fillStyle = `rgba(240, 232, 216, ${opacity})`;
    }
    
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
    ctx.fill();
    
    if (star.size > 1.2) {
      ctx.fillStyle = `rgba(240, 232, 216, ${opacity * 0.15})`;
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.size * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  requestAnimationFrame(drawStars);
}

window.addEventListener('resize', resize);
resize();
requestAnimationFrame(drawStars);

// ─── MOBILE NAV TOGGLE ───
const navToggle = document.getElementById('navToggle');
const navLinks = document.getElementById('navLinks');
if (navToggle && navLinks) {
  navToggle.addEventListener('click', () => {
    navLinks.classList.toggle('open');
    navToggle.textContent = navLinks.classList.contains('open') ? '✕' : '☰';
  });
  // Close nav when a link is clicked
  navLinks.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', () => {
      navLinks.classList.remove('open');
      navToggle.textContent = '☰';
    });
  });
}

// ─── SPA ROUTER — Keep audio alive across navigation ───
(function() {
  const INTERNAL_PAGES = ['index.html', 'chronicles.html', 'about.html', 'stack.html', 'live.html', 'guestbook.html'];

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
      const resp = await fetch(href);
      if (!resp.ok) { window.location.href = href; return; }
      const html = await resp.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      // Swap title
      document.title = doc.title;

      // Swap header or page-header
      const newHeader = doc.querySelector('header') || doc.querySelector('.page-header');
      const oldHeader = document.querySelector('header') || document.querySelector('.page-header');
      if (newHeader && oldHeader) {
        oldHeader.replaceWith(newHeader.cloneNode(true));
      } else if (newHeader && !oldHeader) {
        // Current page has no header but new one does — insert before main
        const main = document.querySelector('main');
        if (main) main.before(newHeader.cloneNode(true));
      } else if (!newHeader && oldHeader) {
        // New page has no separate header
        const newPH = doc.querySelector('.page-header');
        if (newPH) oldHeader.replaceWith(newPH.cloneNode(true));
        else oldHeader.remove();
      }

      // Swap main content
      const newMain = doc.querySelector('main');
      const oldMain = document.querySelector('main');
      if (newMain && oldMain) {
        oldMain.replaceWith(newMain.cloneNode(true));
      }

      // Swap chat orb/float if present
      const newOrb = doc.querySelector('.chat-orb');
      const newFloat = doc.querySelector('.chat-float');
      const oldOrb = document.querySelector('.chat-orb');
      const oldFloat = document.querySelector('.chat-float');
      if (newOrb && !oldOrb) document.body.appendChild(newOrb.cloneNode(true));
      if (!newOrb && oldOrb) oldOrb.remove();
      if (newFloat && !oldFloat) document.body.appendChild(newFloat.cloneNode(true));
      if (!newFloat && oldFloat) oldFloat.remove();

      // Update active nav link
      document.querySelectorAll('.site-nav a').forEach(a => {
        const linkPage = getPageName(a.href);
        a.classList.toggle('active', linkPage === pageName);
      });

      // Execute page-specific inline scripts from new page
      const newScripts = doc.querySelectorAll('main ~ script, .chat-float ~ script');
      newScripts.forEach(s => {
        // Skip scripts.js and lib scripts — those are already loaded
        if (s.src) return;
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
})();
