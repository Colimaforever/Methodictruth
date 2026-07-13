/*!
 * audio-core.js — shared Web-Audio DSP + lifecycle helpers for Methodic Truth tools.
 *
 * Why this exists: every audio tool used to re-implement pitch math, note math, and
 * AudioContext setup inline; run O(n^2) DSP on the main thread inside the paint loop;
 * and never release the audio graph when the tab was hidden. This module centralises
 * the fast, correct versions so every tool gets them for free — one place to fix,
 * consistent behaviour everywhere.
 *
 * Plain global: window.AudioCore. No build step. Also CommonJS-exportable for tests.
 */
(function (root) {
  'use strict';

  /* ── Iterative radix-2 Cooley–Tukey FFT (in-place on real/imag Float32Arrays) ── */
  class FFT {
    constructor(size) {
      if ((size & (size - 1)) !== 0) throw new Error('FFT size must be a power of two');
      this.size = size;
      const half = size >> 1;
      this.cos = new Float32Array(half);
      this.sin = new Float32Array(half);
      for (let i = 0; i < half; i++) {
        this.cos[i] = Math.cos(-2 * Math.PI * i / size);
        this.sin[i] = Math.sin(-2 * Math.PI * i / size);
      }
      const bits = Math.round(Math.log2(size));
      this.rev = new Uint32Array(size);
      for (let i = 0; i < size; i++) {
        let x = i, r = 0;
        for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
        this.rev[i] = r >>> 0;
      }
    }
    // in-place; set inverse=true for IFFT (includes 1/N scaling)
    transform(re, im, inverse) {
      const n = this.size, rev = this.rev, cosT = this.cos, sinT = this.sin;
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (let len = 2; len <= n; len <<= 1) {
        const half = len >> 1, step = (n / len) | 0;
        for (let i = 0; i < n; i += len) {
          for (let k = 0, idx = 0; k < half; k++, idx += step) {
            const c = cosT[idx], s = inverse ? -sinT[idx] : sinT[idx];
            const a = i + k, b = a + half;
            const tre = re[b] * c - im[b] * s;
            const tim = re[b] * s + im[b] * c;
            re[b] = re[a] - tre; im[b] = im[a] - tim;
            re[a] += tre;        im[a] += tim;
          }
        }
      }
      if (inverse) { const inv = 1 / n; for (let i = 0; i < n; i++) { re[i] *= inv; im[i] *= inv; } }
    }
  }

  /* ── Pitch detection: McLeod pitch method (NSDF) via FFT autocorrelation. O(n log n).
   *    The NSDF normalisation + "first peak within 90% of the strongest" rule is what
   *    resists octave errors, and it runs orders of magnitude cheaper than the naive
   *    O(n^2) autocorrelation that was recomputed every animation frame.               ── */
  class PitchDetector {
    constructor(bufferSize, sampleRate, opts) {
      opts = opts || {};
      this.n = bufferSize;
      this.sampleRate = sampleRate;
      this.minFreq = opts.minFreq || 60;
      this.maxFreq = opts.maxFreq || 1300;
      this.clarityThreshold = opts.clarityThreshold != null ? opts.clarityThreshold : 0.5;
      this.rmsThreshold = opts.rmsThreshold != null ? opts.rmsThreshold : 0.008;
      let N = 1; while (N < bufferSize * 2) N <<= 1;   // zero-pad → linear (not circular) autocorrelation
      this.N = N;
      this.fft = new FFT(N);
      this.re = new Float32Array(N);
      this.im = new Float32Array(N);
      this.nsdf = new Float32Array(bufferSize);
    }
    // buf: Float32Array of length n (time-domain). Returns {freq, clarity, rms}; freq < 0 = no pitch.
    detect(buf) {
      const n = this.n, N = this.N, re = this.re, im = this.im, nsdf = this.nsdf;
      let rms = 0; for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
      rms = Math.sqrt(rms / n);
      if (rms < this.rmsThreshold) return { freq: -1, clarity: 0, rms };

      for (let i = 0; i < n; i++) { re[i] = buf[i]; im[i] = 0; }
      for (let i = n; i < N; i++) { re[i] = 0; im[i] = 0; }
      this.fft.transform(re, im, false);
      for (let i = 0; i < N; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; } // power spectrum
      this.fft.transform(re, im, true);                    // re[tau] = autocorrelation r[tau]

      // NSDF[tau] = 2·r[tau] / m[tau], m[tau] = A[tau]+B[tau], computed incrementally.
      const maxLag = Math.min(n - 2, Math.ceil(this.sampleRate / this.minFreq));
      const minLag = Math.max(2, Math.floor(this.sampleRate / this.maxFreq));
      let A = re[0], B = re[0];                             // A[0]=B[0]=energy=r[0]
      nsdf[0] = 1;
      for (let tau = 1; tau <= maxLag; tau++) {
        A -= buf[n - tau] * buf[n - tau];
        B -= buf[tau - 1] * buf[tau - 1];
        const m = A + B;
        nsdf[tau] = m > 0 ? (2 * re[tau]) / m : 0;
      }

      // skip the initial main lobe (down to the first positive→negative zero crossing)
      let tau = 1;
      while (tau < maxLag && nsdf[tau] > 0) tau++;
      let bestLag = -1, bestVal = 0;
      const peaks = [];
      for (let i = Math.max(tau, minLag); i < maxLag; i++) {
        if (nsdf[i] > nsdf[i - 1] && nsdf[i] >= nsdf[i + 1]) {
          peaks.push(i);
          if (nsdf[i] > bestVal) { bestVal = nsdf[i]; bestLag = i; }
        }
      }
      if (bestLag < 0 || bestVal < this.clarityThreshold) return { freq: -1, clarity: bestVal, rms };

      // choose the FIRST peak within 90% of the strongest → picks the fundamental, not a louder harmonic
      const thresh = 0.9 * bestVal;
      let chosen = bestLag;
      for (let p = 0; p < peaks.length; p++) { if (nsdf[peaks[p]] >= thresh) { chosen = peaks[p]; break; } }

      // parabolic interpolation for sub-sample period accuracy
      let lag = chosen;
      if (chosen > 0 && chosen < maxLag) {
        const x1 = nsdf[chosen - 1], x2 = nsdf[chosen], x3 = nsdf[chosen + 1];
        const a = (x1 + x3 - 2 * x2), b = (x3 - x1);
        if (a) lag = chosen - b / (2 * a);
      }
      return { freq: this.sampleRate / lag, clarity: bestVal, rms };
    }
  }

  /* ── Median filter: rejects octave blips & spikes → a needle that sits still ── */
  class MedianFilter {
    constructor(size) { this.size = size || 5; this.buf = []; }
    push(v) { this.buf.push(v); if (this.buf.length > this.size) this.buf.shift(); return this.value(); }
    value() { if (!this.buf.length) return -1; const s = this.buf.slice().sort((a, b) => a - b); return s[s.length >> 1]; }
    reset() { this.buf.length = 0; }
  }

  /* ── Note math ── */
  const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  function noteFromFreq(freq, a4) {
    a4 = a4 || 440;
    const midiFloat = 69 + 12 * Math.log2(freq / a4);
    const midi = Math.round(midiFloat);
    const cents = Math.round((midiFloat - midi) * 100);
    return { note: NOTE_NAMES[((midi % 12) + 12) % 12], octave: Math.floor(midi / 12) - 1, cents, midi };
  }

  /* ── Lifecycle helpers: resume-on-gesture and suspend-when-hidden ── */
  function resume(ctx) {
    if (ctx && ctx.state === 'suspended' && ctx.resume) return ctx.resume();
    return Promise.resolve();
  }
  function onVisibility(onHide, onShow) {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { if (onHide) onHide(); } else { if (onShow) onShow(); }
    });
  }

  const AudioCore = { FFT, PitchDetector, MedianFilter, noteFromFreq, resume, onVisibility, NOTE_NAMES };
  root.AudioCore = AudioCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = AudioCore;

})(typeof window !== 'undefined' ? window : globalThis);
