# GlobalMatch AI: Real-Time Multilingual Live Audio Commentary

GlobalMatch AI is a real-time, multilingual live audio commentary streaming system designed for live sports broadcasting. The system captures or simulates English commentary, translates it dynamically to multiple target languages (Hindi, Gujarati, Spanish, French), and streams high-fidelity human-like neural audio commentary back to listeners in real-time.

---

## 🚀 Key Features

*   **Human-Like Neural Voices**: Integrates Microsoft Edge Neural Text-to-Speech (`edge-tts`) to output highly expressive, realistic voices for all target languages.
*   **Dual-Layer Translation Engine**: Calls the Gemini API (`gemini-2.5-flash`) for translation, with a seamless, automatic fallback to the free Google Translate API in case of API rate limits or quota issues.
*   **WebSocket Orchestration**: Utilizes a lightweight Node.js WebSocket backend to manage language-specific commentary rooms and broadcast audio packets dynamically.
*   **Modern Interactive UI**: Implements a Vite + React client dashboard complete with a live-reacting audio visualizer wave, floating fan emoji reactions, and scoreboard stats.
*   **Microphone Broadcaster (Broadcaster Tool)**: Contains a local tool to translate commentary spoken directly into a microphone in real-time.

---

## 📂 Project Structure

```
├── ai-service/              # Python-based Translation & Neural TTS microservice
│   ├── src/
│   │   ├── main.py          # FastAPI application entrypoint
│   │   ├── translation.py   # Translation logic (Gemini + Free API Fallback)
│   │   ├── tts.py           # Microsoft Edge Neural TTS voice generator
│   │   └── broadcaster.py   # Mic transcription & broadcasting CLI tool
│   └── .env                 # API keys & Configuration (ignored in Git)
│
├── backend/                 # Node.js WebSocket & Orchestration Server
│   ├── server.js            # Express & ws WebSocket router
│   └── .env                 # Server PORT configuration (ignored in Git)
│
├── frontend/                # React Vite Dashboard Client
│   ├── src/
│   │   ├── App.jsx          # React Client UI & Player component
│   │   ├── index.css        # Dashboard Styles
│   │   └── main.jsx         # App mounting entrypoint
│   └── vite.config.js       # Vite configuration
│
└── .gitignore               # Root gitignore rules
```

---

## 🛠️ Setup & Installation

### Prerequisites
*   [Node.js](https://nodejs.org/) (v18+)
*   [Python](https://www.python.org/) (3.9+)

---

### 1. Node.js Backend Server Setup
Navigate to the `backend/` directory, install dependencies, and create a `.env` configuration file:

```bash
cd backend
npm install
```

Create a `.env` file in the `backend/` folder:
```env
PORT=3001
```

Start the server:
```bash
node server.js
```
The server will start listening on `ws://localhost:3001` for WebSocket connections and `http://localhost:3001/internal/stream-update` for commentary updates.

---

### 2. Python AI Service Setup
Navigate to the `ai-service/` directory, install the required packages:

```bash
cd ai-service
pip install fastapi uvicorn httpx python-dotenv edge-tts gTTS SpeechRecognition pyaudio google-genai
```

Create a `.env` file in the `ai-service/` folder:
```env
GEMINI_API_KEY=your_gemini_api_key_here
NODE_WS_URL=http://localhost:3001/internal/stream-update
```

Start the FastAPI application:
```bash
python -m uvicorn src.main:app --port 8000
```

---

### 3. Frontend React Setup
Navigate to the `frontend/` directory, install package dependencies, and run the developer server:

```bash
cd frontend
npm install
npm run dev
```
Open [http://localhost:5173/](http://localhost:5173/) in your web browser.

---

## Watch and translate a YouTube stream

1. Start the Node server, AI service, and frontend as described above. Restart the AI service after pulling changes so the `/audio` route is loaded.
2. In StadiumVoice, choose the language you want to hear, press the play button, and paste a public YouTube URL into **Watch + Translate**.
3. Press **Share tab audio**. In the browser prompt, choose the tab containing the YouTube player and enable **Share tab audio**.
4. Select the source commentary language. The app sends short audio segments to the AI service, displays the recognized phrase, then translates and voices it in the selected listener language.

YouTube embeds cannot be read directly by a webpage because of browser cross-origin protections; explicit tab-audio sharing is the supported route. Chrome or Edge provides the most reliable tab-audio sharing experience.

## 🎮 How to Run the Simulation

1.  Open the web dashboard at [http://localhost:5173/](http://localhost:5173/).
2.  Select your target room language in the dropdown (e.g., **Hindi** or **Gujarati**).
3.  Click the **Play (▶)** button inside the **Live Audio Stream** panel to grant the browser audio permission.
4.  Trigger a simulated game feed for your selected room:
    *   **Hindi**: [http://localhost:8000/simulate/hi](http://localhost:8000/simulate/hi)
    *   **Gujarati**: [http://localhost:8000/simulate/gu](http://localhost:8000/simulate/gu)
    *   **Spanish**: [http://localhost:8000/simulate/es](http://localhost:8000/simulate/es)
    *   **French**: [http://localhost:8000/simulate/fr](http://localhost:8000/simulate/fr)
5.  Watch the commentary update in the live feed in real-time, accompanied by realistic voice commentary playing through your speakers!
