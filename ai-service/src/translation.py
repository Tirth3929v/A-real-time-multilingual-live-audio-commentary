import os
from google import genai

# Ensure env is loaded manually
if os.path.exists('.env'):
    with open('.env', 'r') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                try:
                    key, val = line.split('=', 1)
                    os.environ[key] = val
                except ValueError:
                    pass

import time

import httpx

def translate_free_api(text: str, lang_code: str) -> str:
    try:
        url = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl={lang_code}&dt=t&q={text}"
        r = httpx.get(url, timeout=5)
        res = r.json()
        translated = "".join([part[0] for part in res[0]])
        return translated.strip()
    except Exception as e:
        print(f"Free translate API error: {e}")
        return mock_fallback(text, lang_code)

def translate_commentary(text: str, lang_code: str) -> str:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return translate_free_api(text, lang_code)
        
    lang_names = {
        'es': 'Spanish',
        'hi': 'Hindi',
        'fr': 'French',
        'gu': 'Gujarati',
        'en': 'English'
    }
    target_lang = lang_names.get(lang_code, lang_code)
    prompt = f"Translate the following sports commentary to {target_lang}. Return ONLY the translated text without explanations:\n\n{text}"
    
    max_retries = 3
    delay = 1.5
    
    for attempt in range(max_retries):
        try:
            client = genai.Client(api_key=api_key)
            response = client.models.generate_content(
                model='gemini-2.5-flash',
                contents=prompt
            )
            return response.text.strip()
        except Exception as e:
            print(f"Translation attempt {attempt + 1} failed: {e}")
            if attempt < max_retries - 1:
                time.sleep(delay)
                delay *= 2  # Exponential backoff
            else:
                print(f"All Gemini attempts failed, falling back to Free Translate API.")
                return translate_free_api(text, lang_code)

def mock_fallback(text: str, lang_code: str) -> str:
    lines_map = {
        "Welcome to the FIFA 2026 quarter-finals! The atmosphere here is absolutely electric.": {
            'hi': "फीफा 2026 के क्वार्टर फाइनल में आपका स्वागत है! यहाँ का माहौल पूरी तरह से गरमाया हुआ है।",
            'gu': "ફીફા 2026 ક્વાર્ટર ફાઇનલમાં આપનું સ્વાગત છે! અહીંનું વાતાવરણ એકદમ રોમાંચક છે.",
            'es': "¡Bienvenidos a los cuartos de final de la FIFA 2026! El ambiente aquí es absolutamente eléctrico.",
            'fr': "Bienvenue aux quarts de finale de la FIFA 2026 ! L'atmosphère ici est absolument électrique."
        },
        "Messi passes the ball to the left wing, looking for an opening in the defense.": {
            'hi': "मेस्सी बाईं विंग पर गेंद पास करते हैं, डिफेंस में जगह तलाशते हुए।",
            'gu': "મેસ્સી ડાબી વિંગ પર બોલ પાસ કરે છે, ડિફેન્સમાં જગ્યા શોધી રહ્યા છે.",
            'es': "Messi pasa el balón a la banda izquierda, buscando un hueco en la defensa.",
            'fr': "Messi passe le ballon sur l'aile gauche, cherchant une ouverture dans la défense."
        },
        "He takes the shot! And it's a brilliant save by the goalkeeper!": {
            'hi': "शॉट लगाया! और गोलकीपर ने शानदार बचाव किया है!",
            'gu': "તેણે શૉટ લીધો! અને ગોલકીપર દ્વારા આ એક શાનદાર બચાવ છે!",
            'es': "¡Saca el tiro! ¡Y es una brillante parada del portero!",
            'fr': "Il tente le tir ! Et c'est un arrêt brillant du gardien de but !"
        },
        "The crowd is going wild. What an intense first half we are witnessing.": {
            'hi': "भीड़ बेकाबू हो रही है। क्या ज़बरदस्त पहला हाफ़ हम देख रहे हैं।",
            'gu': "ટોળું ઉત્સાહિત થઈ રહ્યું છે. આપણે એક અદભૂત પ્રથમ હાફ જોઈ રહ્યા છીએ.",
            'es': "La multitud se está volviendo loca. Qué primera mitad tan intensa estamos presenciando.",
            'fr': "La foule est en délire. Quelle première mi-temps intense nous vivons."
        }
    }
    
    clean_text = text.strip()
    if clean_text in lines_map and lang_code in lines_map[clean_text]:
        return lines_map[clean_text][lang_code]

    if lang_code == 'es':
        return f"[ES] {text}"
    elif lang_code == 'hi':
        return f"[HI] {text}"
    elif lang_code == 'fr':
        return f"[FR] {text}"
    elif lang_code == 'gu':
        return f"[GU] {text}"
    return text
