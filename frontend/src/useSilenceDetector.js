/**
 * useSilenceDetector.js
 *
 * Replaces the blind 2-second time-based audio chunking in startCapture()
 * with an AnalyserNode-driven VAD loop. It accumulates audio samples from
 * the existing capture AudioWorklet and only fires onSpeechEnd() when a
 * real pause in speech is detected — producing clean, sentence-aligned chunks.
 *
 * ─── HOW THE DETECTION WORKS ────────────────────────────────────────────────
 *
 *  Volume is measured as RMS (Root Mean Square) over each 128-sample frame
 *  delivered by the AnalyserNode. This gives a linear 0–1 reading that
 *  correlates directly with perceived loudness.
 *
 *  State machine:
 *
 *   IDLE ──(RMS > VOICE_THRESHOLD)──► SPEAKING
 *          Enough energy to be voice.    Start accumulating frames.
 *
 *   SPEAKING ──(RMS < SILENCE_THRESHOLD for >= SILENCE_DURATION_MS)──► FLUSH
 *              Hold until sustained quiet.
 *
 *   FLUSH ──► call onSpeechEnd(wav) ──► back to IDLE
 *             Encode accumulated frames as 16-kHz WAV and fire callback.
 *
 *  Safety valve: MAX_SPEECH_MS caps unbounded accumulation (e.g. commentary
 *  that runs for 10+ seconds without a pause) so the backend never times out.
 *
 * ─── USAGE IN App.jsx ───────────────────────────────────────────────────────
 *
 *   import { useSilenceDetector } from './useSilenceDetector';
 *
 *   // Replace the entire startCapture() body with:
 *   const { startDetection, stopDetection } = useSilenceDetector({
 *     onSpeechEnd: (wavBytes) => sendAudioChunk(wavBytes),
 *     onStatusChange: (msg) => setCaptureStatus(msg),
 *   });
 *
 *   // In the "Share tab audio" button handler:
 *   const stream = await navigator.mediaDevices.getDisplayMedia(...);
 *   startDetection(stream);
 *
 *   // In the "Stop" handler / cleanup:
 *   stopDetection();
 */

import { useRef, useCallback } from 'react';

// ─── Tuning Constants ────────────────────────────────────────────────────────

/**
 * RMS level above which audio is considered "speech".
 * Range: 0.0 – 1.0.  0.012 works well for a commentator mic with background
 * crowd noise.  Lower this if speech is being missed; raise it if crowd noise
 * is being captured as speech.
 */
const VOICE_THRESHOLD = 0.012;

/**
 * RMS level below which audio is considered "silence".
 * Set slightly lower than VOICE_THRESHOLD so there is a hysteresis band that
 * prevents rapid on/off toggling at borderline volume levels.
 */
const SILENCE_THRESHOLD = 0.008;

/**
 * How long (ms) the volume must stay below SILENCE_THRESHOLD before we
 * declare a pause and flush the accumulated audio to the backend.
 * 400 ms is long enough to capture the natural pause between commentary
 * sentences without cutting mid-word.
 */
const SILENCE_DURATION_MS = 400;

/**
 * Hard cap (ms) on a single speech segment.  If the commentator speaks for
 * longer than this without pausing, we flush anyway to avoid sending a huge
 * chunk to STT.  10 seconds is a safe upper bound for a commentary sentence.
 */
const MAX_SPEECH_MS = 10_000;

/**
 * Target sample rate for the WAV payload sent to the backend.
 * The Python vad.py module and Google STT both expect 16 kHz mono PCM.
 */
const TARGET_SAMPLE_RATE = 16_000;

/**
 * FFT size for the AnalyserNode.  Smaller = faster poll; 256 gives ~6 ms
 * resolution at 44.1 kHz and is more than adequate for RMS measurement.
 */
const FFT_SIZE = 256;

// ─── Helper: build a minimal WAV file from a Float32Array ───────────────────

/**
 * Downsample a Float32 PCM buffer from inputRate → TARGET_SAMPLE_RATE and
 * pack it as a 16-bit mono WAV file (identical to floatToWav in App.jsx but
 * self-contained here so the hook has no external dependencies).
 *
 * @param {Float32Array} samples
 * @param {number}       inputRate   - AudioContext.sampleRate (e.g. 44100 or 48000)
 * @returns {Uint8Array}             - complete WAV file bytes
 */
function floatToWav(samples, inputRate) {
  const ratio  = inputRate / TARGET_SAMPLE_RATE;
  const length = Math.floor(samples.length / ratio);
  const pcm    = new Int16Array(length);

  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end   = Math.min(Math.floor((i + 1) * ratio), samples.length);
    let   sum   = 0;
    for (let s = start; s < end; s++) sum += samples[s];
    const avg  = sum / Math.max(1, end - start);
    pcm[i]     = Math.round(Math.max(-1, Math.min(1, avg)) * 0x7fff);
  }

  const dataBytes = pcm.byteLength;
  const buffer    = new ArrayBuffer(44 + dataBytes);
  const view      = new DataView(buffer);
  const str       = (off, val) =>
    [...val].forEach((c, i) => view.setUint8(off + i, c.charCodeAt(0)));

  str(0,  'RIFF');  view.setUint32( 4, 36 + dataBytes,          true);
  str(8,  'WAVE');  str(12, 'fmt '); view.setUint32(16, 16,      true);
  view.setUint16(20, 1,  true);   // PCM
  view.setUint16(22, 1,  true);   // mono
  view.setUint32(24, TARGET_SAMPLE_RATE,           true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2,       true); // byte rate
  view.setUint16(32, 2,  true);   // block align
  view.setUint16(34, 16, true);   // bits per sample
  str(36, 'data');  view.setUint32(40, dataBytes,  true);
  new Int16Array(buffer, 44).set(pcm);

  return new Uint8Array(buffer);
}

// ─── Hook ────────────────────────────────────────────────────────────────────

/**
 * useSilenceDetector({ onSpeechEnd, onStatusChange })
 *
 * @param {object}   options
 * @param {function} options.onSpeechEnd     - Called with (Uint8Array wavBytes) when a phrase ends.
 * @param {function} [options.onStatusChange]- Called with a human-readable status string.
 *
 * @returns {{ startDetection, stopDetection }}
 */
export function useSilenceDetector({ onSpeechEnd, onStatusChange }) {
  // All mutable state lives in refs so the rAF loop always reads current values.
  const contextRef    = useRef(null);  // AudioContext
  const analyserRef   = useRef(null);  // AnalyserNode
  const sourceRef     = useRef(null);  // MediaStreamAudioSourceNode
  const rafRef        = useRef(null);  // requestAnimationFrame handle
  const streamRef     = useRef(null);  // MediaStream (kept to stop tracks)

  // Accumulated audio from the AudioWorklet (raw float samples at native rate).
  const samplesRef    = useRef(/** @type {Float32Array[]} */ ([]));
  const sampleLenRef  = useRef(0);

  // State machine
  const isSpeakingRef    = useRef(false);
  const silenceStartRef  = useRef(0);   // performance.now() when silence began
  const speechStartRef   = useRef(0);   // performance.now() when speech began

  // Reusable typed array for AnalyserNode data (avoids GC pressure in the loop)
  const freqDataRef = useRef(null);

  const status = useCallback((msg) => {
    onStatusChange?.(msg);
  }, [onStatusChange]);

  // ── Internal: compute RMS of current AnalyserNode frame ──────────────────

  function getRms() {
    const analyser = analyserRef.current;
    const data     = freqDataRef.current;
    if (!analyser || !data) return 0;
    analyser.getFloatTimeDomainData(data);
    let sumSq = 0;
    for (let i = 0; i < data.length; i++) sumSq += data[i] * data[i];
    return Math.sqrt(sumSq / data.length);
  }

  // ── Internal: encode accumulated samples and fire the callback ───────────

  function flush() {
    const parts  = samplesRef.current.splice(0);  // drain array in place
    const total  = sampleLenRef.current;
    sampleLenRef.current = 0;

    if (total === 0 || !contextRef.current) return;

    const combined = new Float32Array(total);
    let offset = 0;
    for (const part of parts) { combined.set(part, offset); offset += part.length; }

    const wav = floatToWav(combined, contextRef.current.sampleRate);
    onSpeechEnd(wav);
  }

  // ── Internal: the rAF polling loop ───────────────────────────────────────

  function tick() {
    const rms = getRms();
    const now = performance.now();

    if (!isSpeakingRef.current) {
      // ── IDLE → SPEAKING ──────────────────────────────────────────────────
      if (rms > VOICE_THRESHOLD) {
        isSpeakingRef.current = true;
        speechStartRef.current = now;
        silenceStartRef.current = 0;
        status('🎙 Listening…');
      }
    } else {
      // ── SPEAKING ─────────────────────────────────────────────────────────
      if (rms < SILENCE_THRESHOLD) {
        // Start (or continue) timing the silence window.
        if (silenceStartRef.current === 0) {
          silenceStartRef.current = now;
        } else if (now - silenceStartRef.current >= SILENCE_DURATION_MS) {
          // Silence held long enough → flush the phrase.
          isSpeakingRef.current  = false;
          silenceStartRef.current = 0;
          status('⏳ Processing phrase…');
          flush();
        }
      } else {
        // Still speaking — reset the silence timer.
        silenceStartRef.current = 0;

        // Safety valve: flush if speech runs too long.
        if (now - speechStartRef.current >= MAX_SPEECH_MS) {
          isSpeakingRef.current  = false;
          silenceStartRef.current = 0;
          speechStartRef.current  = 0;
          status('⏳ Processing (max length reached)…');
          flush();
        }
      }
    }

    rafRef.current = requestAnimationFrame(tick);
  }

  // ── Public: startDetection(stream) ───────────────────────────────────────

  /**
   * Wire the hook into an active MediaStream returned by getDisplayMedia().
   * Call this immediately after the user grants tab-sharing permission.
   *
   * This function:
   *  1. Creates an AudioContext + AnalyserNode to measure volume.
   *  2. Adds an AudioWorklet to capture raw float samples.
   *  3. Starts the rAF-driven silence-detection loop.
   *
   * @param {MediaStream} stream
   */
  const startDetection = useCallback(async (stream) => {
    if (!stream.getAudioTracks().length) {
      status('No audio track found in the shared stream.');
      return;
    }

    streamRef.current = stream;

    const context  = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize            = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.4; // gentle smoothing to avoid jitter

    contextRef.current  = context;
    analyserRef.current = analyser;
    freqDataRef.current = new Float32Array(analyser.fftSize);

    const source = context.createMediaStreamSource(stream);
    sourceRef.current = source;

    // AudioWorklet to capture raw float samples (same pattern as the original
    // startCapture but without the fixed 2-second trigger).
    const workletCode = `
      class SilenceCapture extends AudioWorkletProcessor {
        process(inputs) {
          const ch = inputs[0]?.[0];
          if (ch) this.port.postMessage(ch);
          return true;
        }
      }
      registerProcessor('silence-capture', SilenceCapture);
    `;
    const blobUrl = URL.createObjectURL(
      new Blob([workletCode], { type: 'application/javascript' }),
    );
    await context.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);

    const worklet = new AudioWorkletNode(context, 'silence-capture');

    // Collect samples forwarded from the worklet.
    worklet.port.onmessage = (e) => {
      if (!isSpeakingRef.current) return; // Only accumulate during speech.
      const frame = new Float32Array(e.data);
      samplesRef.current.push(frame);
      sampleLenRef.current += frame.length;
    };

    // Route: source → worklet (for sample collection) → analyser (for RMS)
    // The silent gain node prevents the captured audio from playing back locally.
    const silentGain = context.createGain();
    silentGain.gain.value = 0;

    source.connect(worklet);
    source.connect(analyser); // tap the source directly for clean RMS readings
    worklet.connect(silentGain);
    silentGain.connect(context.destination);

    // Stop detection when the user ends screen sharing via the browser UI.
    stream.getVideoTracks()[0]?.addEventListener('ended', () => stopDetection());

    await context.resume();
    status('Listening for commentary — will send on each pause');

    // Reset state machine.
    isSpeakingRef.current   = false;
    silenceStartRef.current = 0;
    samplesRef.current      = [];
    sampleLenRef.current    = 0;

    rafRef.current = requestAnimationFrame(tick);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSpeechEnd]);

  // ── Public: stopDetection() ───────────────────────────────────────────────

  /**
   * Tear down the AudioContext, stop all tracks, and cancel the rAF loop.
   * Safe to call multiple times.
   */
  const stopDetection = useCallback(() => {
    if (rafRef.current)   cancelAnimationFrame(rafRef.current);
    sourceRef.current?.disconnect();
    analyserRef.current?.disconnect();
    contextRef.current?.close();
    streamRef.current?.getTracks().forEach((t) => t.stop());

    contextRef.current    = null;
    analyserRef.current   = null;
    sourceRef.current     = null;
    streamRef.current     = null;
    rafRef.current        = null;
    freqDataRef.current   = null;
    samplesRef.current    = [];
    sampleLenRef.current  = 0;
    isSpeakingRef.current = false;

    status('Capture stopped');
  }, [status]);

  return { startDetection, stopDetection };
}
