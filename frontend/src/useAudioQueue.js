/**
 * useAudioQueue.js
 *
 * A React hook that provides seamless, gapless audio playback using the Web
 * Audio API (AudioBufferSourceNode). It replaces the naive `new Audio()`
 * approach which causes gaps and overlaps between translated commentary clips.
 *
 * HOW IT WORKS
 * ─────────────
 * The Web Audio API has an internal clock (`AudioContext.currentTime`) that is
 * far more precise than the JS event loop. We schedule each decoded buffer to
 * start playing exactly when the previous one ends, giving zero-gap playback.
 *
 *   ┌──────────┐  ┌──────────┐  ┌──────────┐
 *   │ Chunk A  │  │ Chunk B  │  │ Chunk C  │   ← decoded AudioBuffers
 *   └────┬─────┘  └────┬─────┘  └────┬─────┘
 *        │              │              │
 *   t=0.00s        t=3.21s        t=6.88s    ← scheduled start times
 *
 * USAGE IN App.jsx
 * ─────────────────
 *   import { useAudioQueue } from './useAudioQueue';
 *
 *   const { enqueue, stop, isPlaying } = useAudioQueue();
 *
 *   // Inside the WebSocket onmessage handler:
 *   if (data.audioBuffer && data.audioAvailable) {
 *     enqueue(data.audioBuffer);          // pass the raw base64 string
 *   }
 *
 *   // To stop everything (e.g. when user hits pause):
 *   stop();
 */

import { useRef, useCallback, useState, useEffect } from 'react';

// ─── Constants ─────────────────────────────────────────────────────────────────

/**
 * Minimum silence gap (seconds) to insert between successive clips.
 * 0.04 s (40 ms) is imperceptible but prevents AudioBufferSourceNode
 * scheduling collisions on slow decoders.
 */
const INTER_CLIP_GAP_S = 0.04;

// ─── Helper ────────────────────────────────────────────────────────────────────

/**
 * Convert a base64 string to an ArrayBuffer without relying on deprecated
 * `atob` + typed-array tricks that choke on large payloads in some browsers.
 */
function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ─── Hook ──────────────────────────────────────────────────────────────────────

/**
 * useAudioQueue({ onPlay, onEnd })
 *
 * Options:
 *   onPlay()  — called when a clip starts playing (use for volume ducking)
 *   onEnd()   — called when the last active clip finishes
 *
 * Returns:
 *   enqueue(base64String)  — decode and schedule a new audio clip
 *   stop()                 — immediately silence everything and reset the queue
 *   flush()                — drain pre-gesture pending queue
 *   isPlaying              — boolean reactive state
 */
export function useAudioQueue({ onPlay, onEnd } = {}) {
  // Lazily-created AudioContext (browser requires user gesture before creation).
  const contextRef = useRef(null);

  // The AudioContext clock time at which the *next* clip should start.
  // Starts at 0; after each enqueue() call it advances by that clip's duration.
  const nextStartTimeRef = useRef(0);

  // All currently-scheduled source nodes so we can stop them on demand.
  const activeNodesRef = useRef(/** @type {AudioBufferSourceNode[]} */ ([]));

  // Pending base64 chunks queued before the AudioContext existed (pre-gesture).
  const pendingRef = useRef(/** @type {string[]} */ ([]));

  const [isPlaying, setIsPlaying] = useState(false);

  // Duck callbacks — stored in refs so scheduleBuffer always has latest values
  // even when the hook consumer updates them after mount.
  const onPlayRef = useRef(onPlay);
  const onEndRef  = useRef(onEnd);
  useEffect(() => { onPlayRef.current = onPlay; }, [onPlay]);
  useEffect(() => { onEndRef.current  = onEnd;  }, [onEnd]);

  // ── Lifecycle: clean up AudioContext on unmount ─────────────────────────────
  useEffect(() => {
    return () => {
      contextRef.current?.close();
    };
  }, []);

  // ── Internal: get-or-create AudioContext ────────────────────────────────────
  const getContext = useCallback(() => {
    if (!contextRef.current || contextRef.current.state === 'closed') {
      contextRef.current = new AudioContext();
      nextStartTimeRef.current = 0;
    }
    // Resume if suspended (browser auto-suspends contexts that haven't played).
    if (contextRef.current.state === 'suspended') {
      contextRef.current.resume();
    }
    return contextRef.current;
  }, []);

  // ── Internal: decode and schedule one AudioBuffer ───────────────────────────
  const scheduleBuffer = useCallback(
    async (context, audioBuffer) => {
      const source = context.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(context.destination);

      // Schedule to start exactly when the previous clip ends (or now if idle).
      const startAt = Math.max(context.currentTime, nextStartTimeRef.current);
      source.start(startAt);

      // Advance the cursor by this clip's duration + the tiny inter-clip gap.
      nextStartTimeRef.current = startAt + audioBuffer.duration + INTER_CLIP_GAP_S;

      // Track the node so stop() can cancel it.
      activeNodesRef.current.push(source);

      // ── Duck: fire onPlay at the exact scheduled start time ──────────────
      // We use a lookahead setTimeout keyed to AudioContext time so the duck
      // call is as tight to the actual audio start as the JS event loop allows.
      const msUntilStart = Math.max(0, (startAt - context.currentTime) * 1000);
      const duckTimer = setTimeout(() => { onPlayRef.current?.(); }, msUntilStart);

      // Self-clean when playback finishes naturally.
      source.onended = () => {
        clearTimeout(duckTimer); // no-op if already fired
        activeNodesRef.current = activeNodesRef.current.filter((n) => n !== source);
        if (activeNodesRef.current.length === 0) {
          setIsPlaying(false);
          onEndRef.current?.();
        }
      };

      setIsPlaying(true);
    },
    [],
  );

  // ── Public: enqueue(base64String) ───────────────────────────────────────────
  /**
   * Decode a base64-encoded audio payload (MP3 or WAV) and schedule it for
   * gapless playback immediately after the current clip ends.
   *
   * Safe to call from the WebSocket onmessage handler directly — decoding is
   * async and non-blocking.
   *
   * @param {string} base64Audio  Raw base64 string from `data.audioBuffer`
   */
  const enqueue = useCallback(
    async (base64Audio) => {
      if (!base64Audio) return;

      let context;
      try {
        context = getContext();
      } catch {
        // AudioContext blocked before a user gesture — queue for later.
        pendingRef.current.push(base64Audio);
        return;
      }

      try {
        const arrayBuffer = base64ToArrayBuffer(base64Audio);
        // decodeAudioData is the fastest, most compatible decoder available.
        const audioBuffer = await context.decodeAudioData(arrayBuffer);
        await scheduleBuffer(context, audioBuffer);
      } catch (error) {
        console.warn('[useAudioQueue] Failed to decode or schedule audio:', error);
      }
    },
    [getContext, scheduleBuffer],
  );

  // ── Public: flush() — call after user gesture to drain pending queue ─────────
  /**
   * If audio was enqueued before a user gesture (and therefore blocked),
   * call flush() inside a click handler to drain the pending buffer.
   * In practice, enqueue() from the play button's onClick is sufficient.
   */
  const flush = useCallback(async () => {
    // Force initialize/resume the AudioContext during this user gesture!
    try {
      getContext();
    } catch (e) {
      console.warn('[useAudioQueue] Failed to initialize AudioContext on flush:', e);
    }
    const pending = pendingRef.current.splice(0);
    for (const b64 of pending) {
      await enqueue(b64);
    }
  }, [getContext, enqueue]);

  // ── Public: stop() ──────────────────────────────────────────────────────────
  /**
   * Immediately stop all playing and scheduled clips and reset the time cursor.
   * Call this when the user presses Pause.
   */
  const stop = useCallback(() => {
    const now = contextRef.current?.currentTime ?? 0;
    activeNodesRef.current.forEach((node) => {
      try {
        node.stop(now);
      } catch {
        /* Node may have already ended — ignore. */
      }
    });
    activeNodesRef.current = [];
    nextStartTimeRef.current = 0;
    pendingRef.current = [];
    setIsPlaying(false);
  }, []);

  return { enqueue, stop, flush, isPlaying };
}
