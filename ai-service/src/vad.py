"""
vad.py — Voice Activity Detection for smart audio chunking.

Uses webrtcvad (Google's WebRTC VAD engine) to split a raw PCM audio buffer
into voiced speech segments only, discarding silence and stadium noise frames.

Install dependency:  pip install webrtcvad
"""

import struct

# ── webrtcvad import: try the pre-built wheels package first (Windows-friendly),
# then the source package, then fall back to a pure-Python energy VAD so the
# server always starts even without a C compiler.
try:
    import webrtcvad as _webrtcvad          # Linux / Mac source build
    _VAD_BACKEND = "webrtcvad"
except ModuleNotFoundError:
    try:
        import webrtcvad_wheels as _webrtcvad  # Windows pre-built wheel
        _VAD_BACKEND = "webrtcvad-wheels"
    except ModuleNotFoundError:
        _webrtcvad = None
        _VAD_BACKEND = "pure-python-rms"

print(f"[vad] Using VAD backend: {_VAD_BACKEND}")


# ─── Constants ────────────────────────────────────────────────────────────────

# webrtcvad requires 10 ms, 20 ms, or 30 ms frames at 8/16/32/48 kHz.
# We use 16 kHz (matches what the frontend sends) with 30 ms frames for
# best noise-rejection performance.
SAMPLE_RATE = 16_000        # Hz — must match what the client resamples to
FRAME_DURATION_MS = 30      # ms — 30 ms gives best VAD accuracy
FRAME_SIZE = int(SAMPLE_RATE * FRAME_DURATION_MS / 1000)  # samples per frame
BYTES_PER_SAMPLE = 2        # 16-bit PCM = 2 bytes

# Aggressiveness: 0 (least aggressive) → 3 (most aggressive noise filter).
# 2 is a good balance for stadium noise — drops clear background sound while
# keeping the commentator's voice intact.
VAD_AGGRESSIVENESS = 2

# Sliding-window parameters for context-aware voiced/unvoiced decision.
# We accumulate frames in a window; if >VOICED_THRESHOLD% are voiced, the
# region is kept. This avoids single-frame false positives in noisy audio.
WINDOW_DURATION_MS = 300            # look-ahead/look-behind window
WINDOW_FRAMES = WINDOW_DURATION_MS // FRAME_DURATION_MS  # = 10 frames
VOICED_THRESHOLD = 0.90             # ≥90% of window frames must be voiced

# Minimum speech chunk to bother sending to STT (avoids empty transcripts).
MIN_SPEECH_DURATION_MS = 400        # ms
MIN_SPEECH_FRAMES = MIN_SPEECH_DURATION_MS // FRAME_DURATION_MS


# ─── WAV Header Helpers ────────────────────────────────────────────────────────

def strip_wav_header(wav_bytes: bytes) -> bytes:
    """
    Strip the 44-byte WAV header from a WAV buffer and return raw PCM bytes.
    The frontend sends valid WAV files (RIFF header + PCM data).
    """
    if wav_bytes[:4] == b"RIFF":
        return wav_bytes[44:]
    return wav_bytes  # Already raw PCM — pass through unchanged


def build_wav_header(pcm_bytes: bytes, sample_rate: int = SAMPLE_RATE) -> bytes:
    """
    Wrap raw 16-bit mono PCM bytes in a minimal WAV RIFF header so that
    SpeechRecognition can open it with sr.AudioFile().
    """
    num_channels = 1
    bits_per_sample = 16
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    data_size = len(pcm_bytes)
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + data_size,   # chunk size
        b"WAVE",
        b"fmt ",
        16,               # sub-chunk size (PCM)
        1,                # audio format (PCM)
        num_channels,
        sample_rate,
        byte_rate,
        block_align,
        bits_per_sample,
        b"data",
        data_size,
    )
    return header + pcm_bytes


# ─── Core VAD Logic ───────────────────────────────────────────────────────────

def _split_into_frames(pcm: bytes) -> list[bytes]:
    """Divide raw PCM bytes into fixed-size webrtcvad frames, discarding any remainder."""
    frame_bytes = FRAME_SIZE * BYTES_PER_SAMPLE
    return [pcm[i: i + frame_bytes] for i in range(0, len(pcm), frame_bytes) if len(pcm[i: i + frame_bytes]) == frame_bytes]


def _rms_voiced_flags(frames: list[bytes]) -> list[bool]:
    """
    Pure-Python fallback VAD using RMS energy per frame.
    Used when webrtcvad / webrtcvad-wheels are not available.
    Threshold chosen to pass commentary voice while rejecting steady crowd roar.
    """
    RMS_THRESHOLD = 300  # int16 units; tune if needed
    flags = []
    for frame in frames:
        # Unpack all int16 samples in this frame
        n_samples = len(frame) // BYTES_PER_SAMPLE
        samples = struct.unpack(f"<{n_samples}h", frame)
        rms = (sum(s * s for s in samples) / max(1, n_samples)) ** 0.5
        flags.append(rms > RMS_THRESHOLD)
    return flags


def extract_speech_segments(wav_bytes: bytes, aggressiveness: int = VAD_AGGRESSIVENESS) -> list[bytes]:
    """
    Main entry point.  Takes a raw WAV buffer (as sent by the browser), runs
    webrtcvad (or a pure-Python RMS fallback) over every 30 ms frame, and
    returns a list of contiguous voiced speech segments — each one ready to be
    wrapped in a WAV header and fed to SpeechRecognition.

    Args:
        wav_bytes:       Full WAV file bytes (with or without RIFF header).
        aggressiveness:  VAD aggressiveness level 0–3 (default 2 for stadium noise).

    Returns:
        List of raw PCM byte strings, one per detected speech segment.
        Returns an empty list if no speech is detected at all.
    """
    pcm = strip_wav_header(wav_bytes)
    frames = _split_into_frames(pcm)

    if not frames:
        return []

    # ── Build voiced/unvoiced mask ────────────────────────────────────────────
    if _webrtcvad is not None:
        # Preferred path: Google WebRTC VAD (accurate, noise-robust)
        vad = _webrtcvad.Vad(aggressiveness)
        voiced_flags: list[bool] = []
        for frame in frames:
            try:
                is_voiced = vad.is_speech(frame, sample_rate=SAMPLE_RATE)
            except Exception:
                is_voiced = False
            voiced_flags.append(is_voiced)
    else:
        # Fallback: pure-Python RMS energy VAD (no C compiler needed)
        voiced_flags = _rms_voiced_flags(frames)

    # ── Sliding-window smoothing ──────────────────────────────────────────────
    # Raw VAD is noisy (a single loud stadium clap can look like speech for one
    # frame).  We smooth by looking at WINDOW_FRAMES-wide context windows and
    # only marking a frame voiced if enough of its neighbours are also voiced.
    smoothed: list[bool] = []
    half = WINDOW_FRAMES // 2
    for idx in range(len(voiced_flags)):
        window_start = max(0, idx - half)
        window_end = min(len(voiced_flags), idx + half + 1)
        window = voiced_flags[window_start:window_end]
        ratio = sum(window) / len(window)
        smoothed.append(ratio >= VOICED_THRESHOLD)

    # ── Collect contiguous voiced segments ───────────────────────────────────
    segments: list[bytes] = []
    in_speech = False
    current_segment: list[bytes] = []

    for frame, is_voiced in zip(frames, smoothed):
        if is_voiced:
            in_speech = True
            current_segment.append(frame)
        else:
            if in_speech:
                if len(current_segment) >= MIN_SPEECH_FRAMES:
                    segments.append(b"".join(current_segment))
                current_segment = []
                in_speech = False

    # Flush any trailing voiced segment that reaches end of buffer.
    if in_speech and len(current_segment) >= MIN_SPEECH_FRAMES:
        segments.append(b"".join(current_segment))

    return segments


def wav_segments_from_buffer(wav_bytes: bytes) -> list[bytes]:
    """
    Convenience wrapper used by main.py.

    Returns a list of complete WAV file bytes (header + PCM) for each detected
    speech segment.  Each item can be passed directly to sr.AudioFile().
    """
    pcm_segments = extract_speech_segments(wav_bytes)
    return [build_wav_header(pcm) for pcm in pcm_segments]
