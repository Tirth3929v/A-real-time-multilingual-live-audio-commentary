import asyncio
import speech_recognition as sr
from src.main import process_and_broadcast

SPEECH_LANGUAGE_MAP = {
    'en': 'en-US', 'es': 'es-ES', 'fr': 'fr-FR', 'hi': 'hi-IN', 'gu': 'gu-IN'
}

def start_live_commentary(source_language: str = 'en'):
    """Listen in any supported source language, then translate to every room."""
    recognizer = sr.Recognizer()
    sequence_id = 1
    recognition_locale = SPEECH_LANGUAGE_MAP.get(source_language, source_language)

    with sr.Microphone() as source:
        print("Adjusting for ambient noise...")
        recognizer.adjust_for_ambient_noise(source, duration=2)
        print(f"MIC ACTIVE — listening in {recognition_locale}; broadcasting every target language.")
        print("Press Ctrl+C to stop.")
        while True:
            try:
                audio = recognizer.listen(source, timeout=5, phrase_time_limit=10)
                raw_text = recognizer.recognize_google(audio, language=recognition_locale)
                print(f"Heard: {raw_text}")
                asyncio.run(process_and_broadcast(raw_text, sequence_id))
                sequence_id += 1
            except sr.WaitTimeoutError:
                continue
            except sr.UnknownValueError:
                print("Could not understand that speech. Please try again.")
            except KeyboardInterrupt:
                break
            except Exception as error:
                print(f"Broadcast error: {error}")

if __name__ == "__main__":
    # Set this to the language spoken into the microphone: en, es, fr, hi, gu.
    start_live_commentary(source_language='en')
