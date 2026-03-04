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
audio.loop = true;

// Save state continuously so it's always fresh
function saveMusicState() {
  localStorage.setItem('musicState', JSON.stringify({
    track: currentTrack,
    time: audio.currentTime,
    playing: isPlaying,
    volume: audio.volume
  }));
}

// Save on every timeupdate (~4x per second while playing)
audio.addEventListener('timeupdate', saveMusicState);
// Also save on pause, play, and before unload
audio.addEventListener('pause', saveMusicState);
audio.addEventListener('play', saveMusicState);
window.addEventListener('beforeunload', saveMusicState);

// Save state when clicking nav links (belt + suspenders)
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
prevBtn.addEventListener('click', () => { loadTrack(currentTrack - 1); if (isPlaying) audio.play(); });
nextBtn.addEventListener('click', () => { loadTrack(currentTrack + 1); if (isPlaying) audio.play(); });
volumeSlider.addEventListener('input', (e) => { audio.volume = e.target.value / 100; });
audio.addEventListener('ended', () => { loadTrack(currentTrack + 1); audio.play(); });

// Initialize: restore from saved state or start fresh
if (playlist.length > 0) {
  loadTrack(currentTrack);
  if (saved && saved.playing) {
    startPlaying(saved.time || 0);
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
