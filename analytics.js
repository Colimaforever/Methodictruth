/**
 * Simple analytics for methodictruth.com
 * Firebase Realtime Database event tracking (compat API)
 * 
 * Usage:
 *   <script src="analytics.js"></script>
 *   <script>Analytics.init(); Analytics.track('event_name', {data});</script>
 *
 * No SDK. This only ever WRITES, and the Realtime Database has a plain REST
 * interface -- POST to <path>.json is exactly what db.ref(path).push() does on
 * the wire. The compat libraries that used to be required for this cost 193 KB
 * (31 KB app + 162 KB database) on every page that tracked an event, to do what
 * fetch already does in a dozen lines. They bought realtime listeners, offline
 * queueing and auth, none of which a write-only beacon uses.
 */

(function(window) {
  'use strict';

  let sessionId = null;
  let deviceType = null;
  let startTime = null;

  // The REST endpoint events are posted to. The apiKey, appId and the rest of
  // the old client config were only ever needed to construct an SDK instance.
  const EVENTS_URL =
    'https://methodictruth-default-rtdb.firebaseio.com/analytics/events.json';

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
    if (!sessionId) return;
    data = data || {};
    sync = sync || false;

    try {
      const eventData = {
        event: eventName,
        session: sessionId,
        device: deviceType,
        timestamp: Date.now(),
        page: window.location.pathname
      };

      // Merge custom data
      for (const key in data) {
        if (data.hasOwnProperty(key)) {
          eventData[key] = data[key];
        }
      }

      const body = JSON.stringify(eventData);
      if (sync && navigator.sendBeacon) {
        // beforeunload: the page is going away, so hand it to the browser to
        // deliver rather than starting a fetch that will be cancelled.
        navigator.sendBeacon(EVENTS_URL, new Blob([body], { type: 'application/json' }));
      } else {
        // keepalive so a navigation mid-flight does not drop the event either.
        fetch(EVENTS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true
        }).catch(function() { /* analytics must never break the page */ });
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
