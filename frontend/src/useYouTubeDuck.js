/**
 * useYouTubeDuck.js
 *
 * Manages the YouTube IFrame Player API lifecycle and exposes two callbacks —
 * duckVolume() and restoreVolume() — that App.jsx passes into useAudioQueue so
 * the video audio automatically dims whenever a translated clip is playing and
 * snaps back the moment that clip finishes.
 *
 * ─── HOW THE YOUTUBE IFRAME API WORKS ───────────────────────────────────────
 *
 *  The YouTube IFrame Player API is loaded once as a global script tag.  It
 *  fires window.onYouTubeIframeAPIReady() when it is ready.  We then create a
 *  YT.Player instance bound to the <iframe> DOM element and call:
 *
 *    player.setVolume(10)   → duck  (0 – 100 scale)
 *    player.setVolume(100)  → restore
 *
 *  The API is asynchronous — the player is "ready" only after the
 *  onPlayerReady callback fires, so we queue any pending volume calls until
 *  that point.
 *
 * ─── USAGE IN App.jsx ───────────────────────────────────────────────────────
 *
 *   import { useYouTubeDuck } from './useYouTubeDuck';
 *
 *   const { iframeRef, initPlayer, duckVolume, restoreVolume } = useYouTubeDuck();
 *
 *   // Pass the iframe ref to the <iframe> element:
 *   <iframe ref={iframeRef} id="yt-player" src={...} ... />
 *
 *   // Call initPlayer() when a new videoId is loaded:
 *   useEffect(() => { if (videoId) initPlayer(videoId); }, [videoId]);
 *
 *   // Pass the callbacks into useAudioQueue:
 *   const { enqueue, stop, flush } = useAudioQueue({ onPlay: duckVolume, onEnd: restoreVolume });
 *
 * ─── DUCK VOLUME LEVELS ─────────────────────────────────────────────────────
 *
 *  DUCK_VOLUME   10  → barely audible ambient sound while the AI voice speaks
 *  NORMAL_VOLUME 100 → full volume when no translated clip is playing
 *
 *  Both are exported as constants so they are easy to tweak during the hackathon.
 */

import { useRef, useCallback, useEffect } from 'react';

// ─── Constants ───────────────────────────────────────────────────────────────

export const DUCK_VOLUME   = 10;
export const NORMAL_VOLUME = 100;

/** Time (ms) to wait before restoring volume after a clip ends.
 *  A tiny buffer prevents a flash of full volume between back-to-back clips. */
const RESTORE_DELAY_MS = 300;

// ─── Hook ────────────────────────────────────────────────────────────────────

/**
 * useYouTubeDuck()
 *
 * Returns:
 *   iframeRef      - attach to the YouTube <iframe> element via ref={iframeRef}
 *   initPlayer(id) - call after a new videoId is set to bind the YT.Player
 *   duckVolume()   - lower video to DUCK_VOLUME
 *   restoreVolume()- raise video back to NORMAL_VOLUME (with a small delay)
 */
export function useYouTubeDuck() {
  const iframeRef     = useRef(null);       // <iframe> DOM node
  const playerRef     = useRef(null);       // YT.Player instance
  const isReadyRef    = useRef(false);      // true after onPlayerReady fires
  const pendingRef    = useRef(null);       // queued volume value pre-ready
  const restoreTimer  = useRef(null);       // setTimeout handle for restore delay
  const isDuckedRef   = useRef(false);      // prevent redundant API calls

  // ── Internal: apply a volume value, queuing it if player is not yet ready ──

  const setVolume = useCallback((vol) => {
    if (isReadyRef.current && playerRef.current) {
      try { playerRef.current.setVolume(vol); } catch { /* Player may have been destroyed. */ }
    } else {
      // Queue the last requested volume; it will be applied in onPlayerReady.
      pendingRef.current = vol;
    }
  }, []);

  // ── Internal: inject the IFrame API script (idempotent) ──────────────────

  const ensureApiLoaded = useCallback(() => {
    return new Promise((resolve) => {
      if (window.YT?.Player) {
        resolve();
        return;
      }
      // Script already injected but not yet ready.
      if (document.getElementById('yt-iframe-api')) {
        const existing = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => { existing?.(); resolve(); };
        return;
      }
      // First call — inject the script.
      const tag = document.createElement('script');
      tag.id  = 'yt-iframe-api';
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
      const prevReady = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prevReady?.(); resolve(); };
    });
  }, []);

  // ── Public: initPlayer(videoId) ──────────────────────────────────────────

  /**
   * Destroy any existing YT.Player and create a new one bound to the iframe.
   * Must be called whenever videoId changes (i.e. the user loads a new video).
   *
   * The YouTube IFrame API requires the iframe to have an `id` attribute.
   * We enforce this here so callers don't need to remember.
   *
   * @param {string} videoId  11-character YouTube video ID
   */
  const initPlayer = useCallback(async (videoId) => {
    if (!videoId) return;

    await ensureApiLoaded();

    // Destroy the previous player cleanly before creating a new one.
    if (playerRef.current) {
      try { playerRef.current.destroy(); } catch { /* Ignore. */ }
      playerRef.current = null;
      isReadyRef.current = false;
    }

    // The IFrame API needs a stable DOM id to bind to.
    const iframe = iframeRef.current;
    if (!iframe) return;
    if (!iframe.id) iframe.id = 'yt-player';

    playerRef.current = new window.YT.Player(iframe.id, {
      events: {
        onReady: (event) => {
          isReadyRef.current = true;
          // Apply any volume that was requested while the player was initialising.
          if (pendingRef.current !== null) {
            event.target.setVolume(pendingRef.current);
            pendingRef.current = null;
          }
        },
        onError: () => {
          // Non-fatal — the player may be unavailable for some video types.
          isReadyRef.current = false;
        },
      },
    });
  }, [ensureApiLoaded]);

  // ── Public: duckVolume() ─────────────────────────────────────────────────

  /**
   * Lower the YouTube player volume to DUCK_VOLUME.
   * Call this at the moment a translated audio clip begins playing.
   * Idempotent — safe to call multiple times in a row.
   */
  const duckVolume = useCallback(() => {
    if (restoreTimer.current) {
      clearTimeout(restoreTimer.current);
      restoreTimer.current = null;
    }
    if (!isDuckedRef.current) {
      isDuckedRef.current = true;
      setVolume(DUCK_VOLUME);
    }
  }, [setVolume]);

  // ── Public: restoreVolume() ──────────────────────────────────────────────

  /**
   * Restore the YouTube player volume to NORMAL_VOLUME after a short delay.
   * The delay (RESTORE_DELAY_MS) prevents a flash of full volume in the tiny
   * gap between back-to-back translated clips.
   * Idempotent — safe to call multiple times.
   */
  const restoreVolume = useCallback(() => {
    if (restoreTimer.current) clearTimeout(restoreTimer.current);
    restoreTimer.current = setTimeout(() => {
      if (isDuckedRef.current) {
        isDuckedRef.current = false;
        setVolume(NORMAL_VOLUME);
      }
      restoreTimer.current = null;
    }, RESTORE_DELAY_MS);
  }, [setVolume]);

  // ── Lifecycle: clean up on unmount ───────────────────────────────────────

  useEffect(() => {
    return () => {
      if (restoreTimer.current) clearTimeout(restoreTimer.current);
      try { playerRef.current?.destroy(); } catch { /* Ignore. */ }
    };
  }, []);

  return { iframeRef, initPlayer, duckVolume, restoreVolume };
}
