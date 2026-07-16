import os
import asyncio
import base64
import io
import httpx
from fastapi import FastAPI, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import speech_recognition as sr
from dotenv import load_dotenv

# Import the functions we built in the previous step
from src.translation import translate_commentary
from src.tts import generate_audio_stream
from src.vad import wav_segments_from_buffer

load_dotenv()
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

NODE_URL = os.getenv("NODE_WS_URL", "http://localhost:3001/internal/stream-update")

# A mock list of live stadium commentary to simulate a real game
MOCK_FEED = [
    "Welcome to the FIFA 2026 quarter-finals! The atmosphere here is absolutely electric.",
    "Messi passes the ball to the left wing, looking for an opening in the defense.",
    "He takes the shot! And it's a brilliant save by the goalkeeper!",
    "The crowd is going wild. What an intense first half we are witnessing."
]

SUPPORTED_LANGUAGES = ("en", "es", "fr", "hi", "gu")

class CommentaryInput(BaseModel):
    text: str
    sourceLanguage: str = "auto"

class AudioChunk(BaseModel):
    audio: str
    sourceLanguage: str = "en"
    targetLanguage: str = "hi"

SPEECH_LANGUAGE_MAP = {
    'en': 'en-US', 'es': 'es-ES', 'fr': 'fr-FR', 'hi': 'hi-IN', 'gu': 'gu-IN'
}

import sys

def safe_print(msg: str):
    try:
        print(msg)
    except UnicodeEncodeError:
        try:
            encoding = sys.stdout.encoding or 'utf-8'
            print(msg.encode(encoding, errors='replace').decode(encoding))
        except Exception:
            print(msg.encode('ascii', errors='replace').decode('ascii'))

async def process_and_send(text: str, seq_id: int, lang_code: str):
    """The core pipeline: Translate -> TTS -> Send to Node.js"""
    safe_print(f"\n[{seq_id}] Processing: {text}")
    
    # 1. Translate via Gemini
    translated_text = await asyncio.to_thread(translate_commentary, text, lang_code)
    safe_print(f"[{seq_id}] Translated ({lang_code}): {translated_text}")
    
    # 2. Convert to Audio (Base64 buffer)
    audio_b64 = await generate_audio_stream(translated_text, lang_code)
    
    # 3. Send to Node.js Orchestrator
    payload = {
        "sequenceId": seq_id,
        "languageRoom": lang_code,
        "originalText": text,
        "translatedText": translated_text,
        "audioBuffer": audio_b64,
        "audioAvailable": audio_b64 is not None
    }
    
    async with httpx.AsyncClient() as client:
        try:
            await client.post(NODE_URL, json=payload)
            print(f"[{seq_id}] Successfully sent to Node.js!")
        except Exception as e:
            print(f"Failed to send to Node: {e}")

async def process_and_broadcast(text: str, seq_id: int):
    """Send a single source commentary line to every supported language room."""
    await asyncio.gather(*(process_and_send(text, seq_id, language) for language in SUPPORTED_LANGUAGES))

async def run_live_simulation():
    """Simulates a live game feed with a 5-second delay between events"""
    for idx, line in enumerate(MOCK_FEED):
        await process_and_broadcast(line, seq_id=idx+1)
        await asyncio.sleep(5) # Wait 5 seconds before the next commentary line

@app.get("/simulate")
async def start_simulation(background_tasks: BackgroundTasks):
    """
    Start a mock live feed for every supported language room.
    """
    background_tasks.add_task(run_live_simulation)
    return {"message": "Simulation started for all language rooms", "languages": SUPPORTED_LANGUAGES}

@app.get("/simulate/{lang_code}")
async def start_legacy_simulation(lang_code: str, background_tasks: BackgroundTasks):
    """Backward-compatible route; it now broadcasts to all language rooms."""
    if lang_code not in SUPPORTED_LANGUAGES:
        return {"message": "Unsupported language", "languages": SUPPORTED_LANGUAGES}
    background_tasks.add_task(run_live_simulation)
    return {"message": "Simulation started for all language rooms", "languages": SUPPORTED_LANGUAGES}

@app.post("/commentary")
async def receive_commentary(commentary: CommentaryInput, background_tasks: BackgroundTasks):
    """Accept transcribed commentary from any source language and voice it everywhere."""
    text = commentary.text.strip()
    if not text:
        return {"message": "No commentary text received"}
    sequence_id = int(asyncio.get_running_loop().time() * 1000)
    background_tasks.add_task(process_and_broadcast, text, sequence_id)
    return {"message": "Commentary queued", "languages": SUPPORTED_LANGUAGES}

@app.post("/audio")
async def receive_audio(audio_chunk: AudioChunk, background_tasks: BackgroundTasks):
    """
    Transcribe a short PCM WAV segment captured from a shared browser tab.

    Pipeline:
      1. Decode the incoming Base64 WAV buffer.
      2. Run webrtcvad to split the buffer into voiced speech segments,
         discarding silence and background stadium noise between phrases.
      3. Transcribe each voiced segment independently with SpeechRecognition.
      4. Broadcast the combined transcript through the translation → TTS pipeline.
    """
    try:
        raw_audio = base64.b64decode(audio_chunk.audio, validate=True)
    except Exception as error:
        return {"message": "Invalid base64 audio data", "detail": str(error)}

    # ── Step 1: VAD segmentation ──────────────────────────────────────────────
    # wav_segments_from_buffer returns a list of WAV byte-strings, one per
    # detected voiced segment. Silence / pure crowd noise returns an empty list.
    try:
        speech_wav_segments = await asyncio.to_thread(wav_segments_from_buffer, raw_audio)
    except Exception as error:
        print(f"VAD error (falling back to full buffer): {error}")
        speech_wav_segments = [raw_audio]  # Graceful fallback: process entire buffer

    if not speech_wav_segments:
        return {"message": "No speech detected — only silence or background noise found"}

    # ── Step 2: Transcribe each voiced segment ────────────────────────────────
    recognizer = sr.Recognizer()
    locale = SPEECH_LANGUAGE_MAP.get(audio_chunk.sourceLanguage, audio_chunk.sourceLanguage)
    transcripts: list[str] = []

    # Cap at 3 segments per payload to avoid runaway processing on noisy clips.
    for segment_wav in speech_wav_segments[:3]:
        try:
            with sr.AudioFile(io.BytesIO(segment_wav)) as source:
                audio_data = recognizer.record(source)
            text = await asyncio.to_thread(
                recognizer.recognize_google, audio_data, language=locale
            )
            if text:
                transcripts.append(text.strip())
        except sr.UnknownValueError:
            continue  # This segment had no recognisable speech — skip it
        except Exception as err:
            print(f"Segment transcription error: {err}")
            continue

    if not transcripts:
        return {"message": "No speech detected in any voiced segment"}

    # Join multiple voiced segments separated by " — " for readability.
    full_transcript = " — ".join(transcripts)
    safe_print(f"[VAD] Recognised {len(transcripts)} segment(s): {full_transcript}")

    # ── Step 3: Translate and broadcast ──────────────────────────────────────
    sequence_id = int(asyncio.get_running_loop().time() * 1000)
    background_tasks.add_task(process_and_send, full_transcript, sequence_id, audio_chunk.targetLanguage)
    return {"message": "Audio translated", "transcript": full_transcript, "languages": SUPPORTED_LANGUAGES}

@app.get("/")
def read_root():
    return {"status": "AI Service is running!"}
