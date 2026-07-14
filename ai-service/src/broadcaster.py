import speech_recognition as sr
import asyncio
from src.main import process_and_send # Import your existing pipeline function

def start_live_commentary(target_language: str):
    """
    Listens to the microphone continuously and sends the transcribed text 
    to your Gemini translation and TTS pipeline.
    """
    recognizer = sr.Recognizer()
    seq_id = 1

    with sr.Microphone() as source:
        print("\n🎙️ Adjusting for ambient noise... Please wait.")
        recognizer.adjust_for_ambient_noise(source, duration=2)
        print(f"✅ MIC ACTIVE! Start speaking your live commentary. Translating to: {target_language}")
        print("(Press Ctrl+C to stop)\n")

        while True:
            try:
                # Listen for a short phrase
                audio = recognizer.listen(source, timeout=5, phrase_time_limit=10)
                
                # Convert speech to text (English by default for the input)
                print("Processing speech...")
                raw_text = recognizer.recognize_google(audio)
                print(f"🗣️ You said: '{raw_text}'")

                # Send it to your existing GenAI pipeline!
                # We use asyncio.run because process_and_send is an async function
                asyncio.run(process_and_send(text=raw_text, seq_id=seq_id, lang_code=target_language))
                seq_id += 1

            except sr.WaitTimeoutError:
                continue # Nobody spoke, keep listening
            except sr.UnknownValueError:
                print("Could not understand audio, please speak clearer.")
            except Exception as e:
                print(f"Error: {e}")
                break

# Run the live mic if this script is executed directly
if __name__ == "__main__":
    # Choose your target language room here (e.g., 'hi' for Hindi, 'es' for Spanish)
    start_live_commentary(target_language='hi')
