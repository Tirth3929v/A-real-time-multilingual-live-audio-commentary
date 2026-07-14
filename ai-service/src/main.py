import os
import asyncio
import httpx
from fastapi import FastAPI, BackgroundTasks
from dotenv import load_dotenv

# Import the functions we built in the previous step
from src.translation import translate_commentary
from src.tts import generate_audio_stream

load_dotenv()
app = FastAPI()

NODE_URL = os.getenv("NODE_WS_URL", "http://localhost:3001/internal/stream-update")

# A mock list of live stadium commentary to simulate a real game
MOCK_FEED = [
    "Welcome to the FIFA 2026 quarter-finals! The atmosphere here is absolutely electric.",
    "Messi passes the ball to the left wing, looking for an opening in the defense.",
    "He takes the shot! And it's a brilliant save by the goalkeeper!",
    "The crowd is going wild. What an intense first half we are witnessing."
]

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
    translated_text = translate_commentary(text, lang_code)
    safe_print(f"[{seq_id}] Translated ({lang_code}): {translated_text}")
    
    # 2. Convert to Audio (Base64 buffer)
    audio_b64 = await generate_audio_stream(translated_text, lang_code)
    
    # 3. Send to Node.js Orchestrator
    payload = {
        "sequenceId": seq_id,
        "languageRoom": lang_code,
        "originalText": text,
        "translatedText": translated_text,
        "audioBuffer": audio_b64
    }
    
    async with httpx.AsyncClient() as client:
        try:
            await client.post(NODE_URL, json=payload)
            print(f"[{seq_id}] Successfully sent to Node.js!")
        except Exception as e:
            print(f"Failed to send to Node: {e}")

async def run_live_simulation(lang_code: str):
    """Simulates a live game feed with a 5-second delay between events"""
    for idx, line in enumerate(MOCK_FEED):
        await process_and_send(line, seq_id=idx+1, lang_code=lang_code)
        await asyncio.sleep(5) # Wait 5 seconds before the next commentary line

@app.get("/simulate/{lang_code}")
async def start_simulation(lang_code: str, background_tasks: BackgroundTasks):
    """
    Hit this endpoint to start the mock live feed. 
    Supported lang_codes: 'es' (Spanish), 'hi' (Hindi), 'fr' (French), etc.
    """
    background_tasks.add_task(run_live_simulation, lang_code)
    return {"message": f"Simulation started for language: {lang_code}"}

@app.get("/")
def read_root():
    return {"status": "AI Service is running!"}
