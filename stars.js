// stars.js — shared starfield canvas renderer
//
// Stars are generated once and kept. They used to be re-randomised inside
// draw(), which meant every resize dealt a brand new sky -- and on a phone
// `resize` fires whenever the browser chrome hides or shows during a scroll,
// so the background visibly reshuffled while you read. Same reason the resize
// handler is debounced: that event arrives in bursts, and each one redrew a
// few hundred arcs for no benefit.
(function() {
  function initStars() {
    const canvas = document.getElementById('stars');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let stars = [];

    // Positions are stored as fractions of the canvas, so a resize moves the
    // same sky rather than replacing it.
    function populate(n) {
      while (stars.length < n) {
        stars.push({
          fx: Math.random(), fy: Math.random(),
          r: Math.random() * 1.2,
          a: Math.random() * 0.6 + 0.1
        });
      }
    }

    function draw() {
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const count = Math.floor((w * h) / 6000);
      populate(count);
      for (let i = 0; i < count; i++) {
        const s = stars[i];
        ctx.beginPath();
        ctx.arc(s.fx * w, s.fy * h, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${s.a})`;
        ctx.fill();
      }
    }

    function resize() {
      // Ignore the height-only changes a mobile URL bar produces; redrawing
      // for those was most of the work this handler ever did.
      const w = window.innerWidth, h = window.innerHeight;
      if (canvas.width === w && Math.abs(canvas.height - h) < 120) return;
      canvas.width = w;
      canvas.height = h;
      draw();
    }

    let t = null;
    window.addEventListener('resize', function() {
      clearTimeout(t);
      t = setTimeout(resize, 150);
    });

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    draw();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initStars);
  } else {
    initStars();
  }
})();
