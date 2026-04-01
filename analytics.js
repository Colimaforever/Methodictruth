/**
 * Simple analytics for methodictruth.com
 * Firebase Realtime Database event tracking (compat API)
 * 
 * Usage:
 *   <script src="lib/firebase-app-compat.js"></script>
 *   <script src="lib/firebase-database-compat.js"></script>
 *   <script src="analytics.js"></script>
 *   <script>Analytics.init(); Analytics.track('event_name', {data});</script>
 */

(function(window) {
  'use strict';

  let db = null;
  let sessionId = null;
  let deviceType = null;
  let startTime = null;
  let firebaseInitialized = false;

  // Firebase config
  const firebaseConfig = {
    apiKey: "AIzaSyDosCOXMInZQoOkgNEhbTCzzXEy1rdkCFA",
    authDomain: "methodictruth.firebaseapp.com",
    databaseURL: "https://methodictruth-default-rtdb.firebaseio.com",
    projectId: "methodictruth",
    storageBucket: "methodictruth.firebasestorage.app",
    messagingSenderId: "415814328505",
    appId: "1:415814328505:web:6f8ad89f05d944d4087b68"
  };

  // Detect device type
  function detectDevice() {
    const ua = navigator.userAgent;
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    if (/Mobile/i.test(ua)) return 'mobile';
    return 'desktop';
  }

  // Initialize analytics
  function init() {
    try {
      // Init Firebase if not already done
      if (!firebaseInitialized && typeof firebase !== 'undefined') {
        if (!firebase.apps.length) {
          firebase.initializeApp(firebaseConfig);
        }
        db = firebase.database();
        firebaseInitialized = true;
      }

      sessionId = Math.random().toString(36).substring(2, 15);
      deviceType = detectDevice();
      startTime = Date.now();
      
      // Log session start
      track('session_start', {
        device: deviceType,
        page: window.location.pathname,
        referrer: document.referrer || 'direct',
        screen: `${window.innerWidth}x${window.innerHeight}`,
        userAgent: navigator.userAgent.substring(0, 200)
      });

      // Track session pause
      document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
          track('session_pause', {
            duration: Math.round((Date.now() - startTime) / 1000)
          });
        }
      });

      // Track session end (best effort)
      window.addEventListener('beforeunload', function() {
        track('session_end', {
          duration: Math.round((Date.now() - startTime) / 1000)
        }, true);
      });

    } catch (error) {
      console.warn('Analytics init failed:', error);
    }
  }

  // Track an event
  function track(eventName, data, sync) {
    if (!db || !sessionId) return;
    data = data || {};
    sync = sync || false;

    try {
      const eventData = {
        event: eventName,
        session: sessionId,
        device: deviceType,
        timestamp: firebase.database.ServerValue.TIMESTAMP,
        page: window.location.pathname
      };

      // Merge custom data
      for (const key in data) {
        if (data.hasOwnProperty(key)) {
          eventData[key] = data[key];
        }
      }

      if (sync && navigator.sendBeacon) {
        // Best-effort sync write for beforeunload
        const blob = new Blob([JSON.stringify(eventData)], { type: 'application/json' });
        navigator.sendBeacon(
          'https://methodictruth-default-rtdb.firebaseio.com/analytics/events.json',
          blob
        );
      } else {
        // Async write
        db.ref('analytics/events').push(eventData).catch(function(err) {
          console.warn('Analytics write failed:', err);
        });
      }
    } catch (error) {
      console.warn('Analytics track failed:', error);
    }
  }

  // Debounced tracker for high-frequency events
  const debouncedEvents = new Map();

  function trackDebounced(eventName, data, delay) {
    data = data || {};
    delay = delay || 2000;
    const key = eventName + '_' + JSON.stringify(data);
    
    if (debouncedEvents.has(key)) {
      clearTimeout(debouncedEvents.get(key));
    }

    const timeoutId = setTimeout(function() {
      track(eventName, data);
      debouncedEvents.delete(key);
    }, delay);

    debouncedEvents.set(key, timeoutId);
  }

  // Synth-specific event helpers
  const Synth = {
    moduleAdded: function(type) { track('module_added', { moduleType: type }); },
    moduleRemoved: function(type) { track('module_removed', { moduleType: type }); },
    cableCreated: function(from, to) { track('cable_created', { from: from, to: to }); },
    cableRemoved: function() { track('cable_removed'); },
    presetLoaded: function(name) { track('preset_loaded', { preset: name }); },
    clearAll: function() { track('clear_all'); },
    audioStarted: function() { track('audio_started'); },
    noteTriggered: function(source) { track('note_triggered', { source: source }); },
    midiConnected: function() { track('midi_connected'); },
    kbToggled: function(visible) { track('kb_toggled', { visible: visible }); },
    kbPanelOpened: function() { track('kb_panel_opened'); },
    paramChanged: function(moduleType, param) {
      trackDebounced('param_changed', { moduleType: moduleType, param: param }, 3000);
    },
    songUploaded: function() { track('song_uploaded'); },
    error: function(message) {
      track('error', { message: String(message).substring(0, 200) });
    }
  };

  // Expose public API
  window.Analytics = {
    init: init,
    track: track,
    trackDebounced: trackDebounced,
    Synth: Synth
  };

})(window);
