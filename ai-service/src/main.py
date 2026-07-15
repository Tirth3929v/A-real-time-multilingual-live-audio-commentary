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

load_dotenv()
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
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
    """Transcribe a short PCM WAV segment captured from a shared browser tab."""
    try:
        raw_audio = base64.b64decode(audio_chunk.audio, validate=True)
        recognizer = sr.Recognizer()
        with sr.AudioFile(io.BytesIO(raw_audio)) as source:
            audio_data = recognizer.record(source)
        locale = SPEECH_LANGUAGE_MAP.get(audio_chunk.sourceLanguage, audio_chunk.sourceLanguage)
        transcript = await asyncio.to_thread(recognizer.recognize_google, audio_data, language=locale)
    except sr.UnknownValueError:
        return {"message": "No speech detected"}
    except Exception as error:
        print(f"Audio transcription error: {error}")
        return {"message": "Audio could not be transcribed", "detail": str(error)}

    sequence_id = int(asyncio.get_running_loop().time() * 1000)
    background_tasks.add_task(process_and_send, transcript, sequence_id, audio_chunk.targetLanguage)
    return {"message": "Audio translated", "transcript": transcript, "languages": SUPPORTED_LANGUAGES}

@app.get("/")
def read_root():
    return {"status": "AI Service is running!"}
