import { useEffect, useRef, useState, useCallback } from 'react';
import './index.css';
import { useAudioQueue }       from './useAudioQueue';
import { useSilenceDetector }  from './useSilenceDetector';
import { useYouTubeDuck }      from './useYouTubeDuck';

const reactionsList = ['🔥', '⚽', '👏', '🇪🇸', '🇮🇳', '🎉'];
const languages = [
  { value: 'en', label: 'English', native: 'English' },
  { value: 'es', label: 'Spanish', native: 'Español' },
  { value: 'fr', label: 'French', native: 'Français' },
  { value: 'hi', label: 'Hindi', native: 'हिन्दी' },
  { value: 'gu', label: 'Gujarati', native: 'ગુજરાતી' },
];


const Icon = ({ name, size = 20 }) => {
  const paths = {
    play: <path d="m7 4 11 8-11 8V4Z" fill="currentColor" stroke="none" />,
    pause: <><path d="M7 5v14M17 5v14" /></>,
    volume: <><path d="M5 10v4h4l5 4V6l-5 4H5Z" /><path d="M16 9.5a4 4 0 0 1 0 5" /></>,
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.3 2.5 3.4 5.5 3.4 9s-1.1 6.5-3.4 9c-2.3-2.5-3.4-5.5-3.4-9S9.7 5.5 12 3Z" /></>,
    chevron: <path d="m8 10 4 4 4-4" />,
    spark: <path d="m12 2 1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7L12 2Z" />,
    send: <path d="m21 3-7.5 18-3.5-7-7-3.5L21 3Zm-7.5 11L21 3" />,
    mic: <><rect x="8" y="3" width="8" height="12" rx="4" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" /></>,
    video: <><rect x="3" y="5" width="14" height="14" rx="2" /><path d="m17 10 4-3v10l-4-3" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
};

export default function App() {
  const [language, setLanguage] = useState('hi');
  const [isPlaying, setIsPlaying] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [liveText, setLiveText] = useState([]);
  const [reactions, setReactions] = useState([]);
  const [videoUrl, setVideoUrl] = useState('');
  const [videoId, setVideoId] = useState('');
  const [captureStatus, setCaptureStatus] = useState('Ready to capture a shared tab');
  const [isCapturing, setIsCapturing] = useState(false);
  const [sourceLanguage, setSourceLanguage] = useState('en');
  const wsRef          = useRef(null);
  const isPlayingRef   = useRef(false);
  const languageRef    = useRef('hi');
  const sourceLanguageRef = useRef('en');

  // ── YouTube duck hook ───────────────────────────────────────────────
  const { iframeRef, initPlayer, duckVolume, restoreVolume } = useYouTubeDuck();

  // ── Gapless audio queue (with duck callbacks) ──────────────────────────
  const { enqueue, stop: stopAudio, flush } = useAudioQueue({
    onPlay: duckVolume,
    onEnd:  restoreVolume,
  });

  const selectedLanguage = languages.find(({ value }) => value === language);

  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { languageRef.current = language; }, [language]);
  useEffect(() => { sourceLanguageRef.current = sourceLanguage; }, [sourceLanguage]);

  // ── Silence-detector hook — declared here so it is ALWAYS above regular ──
  // functions. React's Rules of Hooks require every hook call to occur
  // unconditionally at the top level of the component. Moving useCallback and
  // useSilenceDetector above loadVideo / startCapture fixes the hook-order crash.
  const sendAudioChunk = useCallback(async (wavBytes) => {
    try {
      const binary = String.fromCharCode(...wavBytes);
      const request = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio: btoa(binary),
          sourceLanguage: sourceLanguageRef.current,
          targetLanguage: languageRef.current,
        }),
      };
      const aiBackendUrl = import.meta.env.MODE === 'production'
        ? (import.meta.env.VITE_AI_BACKEND_URL || 'https://stadiumvoice-ai.onrender.com')
        : 'http://127.0.0.1:8000';
      const AUDIO_ENDPOINTS = [
        '/api/audio',
        `${aiBackendUrl}/audio`,
        'http://127.0.0.1:8000/audio'
      ];
      let lastError = null;
      let lastResult = null;
      for (const endpoint of AUDIO_ENDPOINTS) {
        try {
          const response = await fetch(endpoint, request);
          const result   = await response.json().catch(() => ({}));
          // If the server proxy is misconfigured or returns a transient gateway error, failover.
          if (response.status === 404 || response.status === 502 || response.status === 504) {
            lastResult = result;
            continue;
          }
          if (result.transcript) {
            setCaptureStatus(`Heard: "${result.transcript}"`);
            return; // Success!
          } else if (!response.ok) {
            setCaptureStatus(result.detail || result.message || 'Speech could not be translated.');
            return;
          }
        } catch (err) {
          lastError = err;
          // Continue to next fallback url (e.g. direct to Python API instead of Vite proxy)
          continue;
        }
      }
      if (lastError) throw lastError;
      setCaptureStatus(lastResult?.message || 'AI service needs to be restarted.');
    } catch {
      setCaptureStatus('AI service unavailable — start it on port 8000.');
    }
  }, []);

  const { startDetection, stopDetection } = useSilenceDetector({
    onSpeechEnd:    sendAudioChunk,
    onStatusChange: setCaptureStatus,
  });

  // Stable ref so the WebSocket cleanup effect can call stopDetection() without
  // adding it to the effect dependency array (which would reconnect the socket
  // every time stopDetection changes identity after a re-render).
  const stopDetectionRef = useRef(stopDetection);
  useEffect(() => { stopDetectionRef.current = stopDetection; }, [stopDetection]);

  // YT Player must be initialized in useEffect after the new iframe DOM element
  // has been mounted by React (since key={videoId} destroys and recreates it).
  useEffect(() => {
    if (videoId) {
      initPlayer(videoId);
    }
  }, [videoId, initPlayer]);

  useEffect(() => {
    const wsUrl = import.meta.env.MODE === 'production'
      ? 'wss://a-real-time-multilingual-live-audio.onrender.com'
      : (import.meta.env.VITE_NODE_ORCHESTRATOR_URL || 'ws://localhost:3001');
    wsRef.current = new WebSocket(wsUrl);
    wsRef.current.onopen = () => {
      setIsConnected(true);
      wsRef.current.send(JSON.stringify({ type: 'join_room', language: languageRef.current }));
    };
    wsRef.current.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'TRANSLATION_BURST') {
          speakWithBrowserVoice(data.text, languageRef.current);
          setLiveText((prev) => [{ id: data.sequenceId || data.seqId || Date.now(), time: 'LIVE NOW', text: data.text }, ...prev].slice(0, 10));
          return;
        }
        const text = data.translatedText || (data.type === 'text' && data.payload);
        if (text) setLiveText((prev) => [{ id: data.sequenceId || data.seqId || Date.now(), time: 'LIVE NOW', text }, ...prev].slice(0, 10));
        // Only enqueue audio when the player is active.
        if (isPlayingRef.current) {
          if (data.audioAvailable && data.audioBuffer) {
            // Gapless Web Audio API path — always preferred.
            enqueue(data.audioBuffer);
          } else if (text) {
            // Text-only fallback: browser SpeechSynthesis.
            speakWithBrowserVoice(text, languageRef.current);
          }
        }
      } catch { /* Ignore malformed stream packets. */ }
    };
    wsRef.current.onclose = () => setIsConnected(false);
    return () => { wsRef.current?.close(); window.speechSynthesis?.cancel(); stopDetectionRef.current(); };
  }, [enqueue]);

  function getYouTubeId(value) {
    if (!value) return '';
    const s = value.trim();

    // Short link:  youtu.be/<ID>
    if (s.includes('youtu.be/')) {
      return s.split('youtu.be/')[1].split(/[?&]/)[0];
    }
    // Standard:    youtube.com/watch?v=<ID>  or  ?v=<ID>&...
    if (s.includes('v=')) {
      return s.split('v=')[1].split(/[?&#]/)[0];
    }
    // Embed link:  youtube.com/embed/<ID>
    if (s.includes('embed/')) {
      return s.split('embed/')[1].split(/[?&]/)[0];
    }
    // Shorts:      youtube.com/shorts/<ID>
    if (s.includes('/shorts/')) {
      return s.split('/shorts/')[1].split(/[?&]/)[0];
    }
    // Bare 11-char video ID pasted directly
    return s.match(/^[\w-]{11}$/)?.[0] || '';
  }

  function loadVideo(event) {
    event.preventDefault();
    const id = getYouTubeId(videoUrl);
    setVideoId(id);
    if (id) {
      setCaptureStatus('Video loaded — choose “share audio” to translate it');
    } else {
      setCaptureStatus('Paste a valid YouTube URL or video ID');
    }
  }

  async function startCapture() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setCaptureStatus('This browser does not support tab-audio sharing. Use Chrome or Edge.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { suppressLocalAudioPlayback: true },
      });
      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach((t) => t.stop());
        setCaptureStatus('No audio was shared. Select the YouTube tab and enable “Share tab audio”.');
        return;
      }
      await startDetection(stream);
      setIsCapturing(true);
    } catch (error) {
      setCaptureStatus(error.name === 'NotAllowedError' ? 'Tab sharing was cancelled.' : 'Could not start audio capture.');
    }
  }

  function stopCapture() {
    stopDetection();
    setIsCapturing(false);
  }

  // speakWithBrowserVoice is kept as the text-only fallback path when the
  // server does not return an audioBuffer (e.g. during TTS failures).
  function speakWithBrowserVoice(text, langCode) {
    if (!('speechSynthesis' in window)) return Promise.resolve();
    const locale = { en: 'en-US', es: 'es-ES', fr: 'fr-FR', hi: 'hi-IN', gu: 'gu-IN' }[langCode] || 'en-US';
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = locale;
    utterance.rate = 1.03;
    const voice = window.speechSynthesis.getVoices().find((item) => item.lang.toLowerCase().startsWith(locale.slice(0, 2).toLowerCase()));
    if (voice) utterance.voice = voice;
    return new Promise((resolve) => {
      utterance.onend = resolve;
      utterance.onerror = resolve;
      window.speechSynthesis.speak(utterance);
    });
  }

  useEffect(() => {
    if (!isPlaying) return undefined;
    const interval = setInterval(() => {
      if (Math.random() > 0.45) {
        const reaction = { id: Date.now(), emoji: reactionsList[Math.floor(Math.random() * reactionsList.length)] };
        setReactions((prev) => [...prev, reaction]);
        setTimeout(() => setReactions((prev) => prev.filter((item) => item.id !== reaction.id)), 2600);
      }
    }, 850);
    return () => clearInterval(interval);
  }, [isPlaying]);

  function changeLanguage(event) {
    const nextLanguage = event.target.value;
    setLanguage(nextLanguage);
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'join_room', language: nextLanguage }));
  }

  return (
    <div className="app-shell">
      <div className="grain" />
      <nav className="topbar">
        <a className="brand" href="#top" aria-label="Stadium Voice home"><span className="brand-mark"><Icon name="spark" size={17} /></span><span>stadium<span>voice</span></span></a>
        <div className="nav-context"><span className="live-dot" /> FIFA WORLD CUP 2026 <span className="nav-separator" /> LIVE EXPERIENCE</div>
        <div className="topbar-status"><span className={`status-pill ${isConnected ? 'online' : ''}`}><i />{isConnected ? 'LIVE' : 'OFFLINE'}</span><span className="clock">87:24</span></div>
      </nav>

      <main id="top" className="experience">
        <section className="match-hero" aria-label="Match scoreboard">
          <div className="match-meta"><span>GROUP STAGE · MATCHDAY 2</span><span>METLIFE STADIUM · EAST RUTHERFORD</span></div>
          <div className="scoreline">
            <div className="team team-left"><div className="crest crest-spain">ESP</div><div><strong>Spain</strong><small>La Roja</small></div></div>
            <div className="score"><strong>2<span>–</span>1</strong><div><span className="live-dot" /> 88' · SECOND HALF</div></div>
            <div className="team team-right"><div><strong>India</strong><small>Blue Tigers</small></div><div className="crest crest-india">IND</div></div>
          </div>
          <div className="match-event"><span className="event-minute">86'</span><span className="event-ball">●</span><span>Morata finds the net from inside the box</span><span className="event-tag">GOAL</span></div>
        </section>

        <section className="watch-section" aria-label="Watch and translate a YouTube stream">
          <div className="watch-copy"><span className="section-kicker">WATCH + TRANSLATE</span><h1>Your match.<br /><em>Your language.</em></h1><p>Paste any public YouTube match video, then share that tab’s audio. StadiumVoice transcribes the source and speaks it in your selected language.</p><div className={`capture-state ${isCapturing ? 'active' : ''}`}><span className="live-dot" />{captureStatus}</div></div>
          <div className="video-console">
            <div className="youtube-wrapper" style={{ display: 'contents' }}>
              {videoId
                ? <iframe
                    ref={iframeRef}
                    id="yt-player"
                    key={videoId}
                    className="youtube-frame"
                    src={`https://www.youtube.com/embed/${videoId}?autoplay=0&rel=0&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`}
                    title="YouTube match source"
                    allow="autoplay; encrypted-media; picture-in-picture"
                    allowFullScreen
                  />
                : <div className="video-placeholder"><Icon name="video" size={36} /><strong>Load a public YouTube video</strong><span>Its audio stays in the player while your selected translation voice plays here.</span></div>
              }
            </div>
            <form className="video-form" onSubmit={loadVideo}><span><Icon name="link" size={16} /></span><input value={videoUrl} onChange={(event) => setVideoUrl(event.target.value)} placeholder="Paste YouTube video URL or ID" aria-label="YouTube video URL" /><button type="submit">Load video</button></form>
            <div className="capture-controls"><div><small>SOURCE LANGUAGE</small><select value={sourceLanguage} onChange={(event) => setSourceLanguage(event.target.value)}>{languages.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></div><button className={`capture-button ${isCapturing ? 'stop' : ''}`} type="button" onClick={isCapturing ? stopCapture : startCapture}><Icon name="mic" size={17} />{isCapturing ? 'Stop listening' : 'Share tab audio'}</button></div>
          </div>
        </section>

        <section className="dashboard-grid">
          <article className="listen-card">
            <div className="card-eyebrow"><span><span className="live-dot" /> LIVE COMMENTARY</span><span className="listener-count">● 12.8K listening</span></div>
            <div className="listen-intro"><p>Hear every moment, <em>in your language.</em></p><span>AI-powered commentary, delivered in real time.</span></div>
            <div className="audio-deck">
              <button className={`play-button ${isPlaying ? 'playing' : ''}`} onClick={() => {
                setIsPlaying((value) => {
                  if (value) {
                    // Pause: immediately silence the Web Audio queue.
                    stopAudio();
                    window.speechSynthesis?.cancel();
                  } else {
                    // Resume: flush any audio that arrived before the gesture.
                    flush();
                  }
                  return !value;
                });
              }} aria-label={isPlaying ? 'Pause commentary' : 'Listen to commentary'}><Icon name={isPlaying ? 'pause' : 'play'} size={25} /></button>
              <div className="waveform" aria-hidden="true">{Array.from({ length: 36 }, (_, i) => <i key={i} style={{ '--i': i, '--h': `${20 + ((i * 37) % 68)}%`, animationPlayState: isPlaying ? 'running' : 'paused' }} />)}</div>
              <button className="volume-button" aria-label="Volume"><Icon name="volume" size={20} /></button>
            </div>
            <div className="audio-footer"><span>{isPlaying ? 'NOW PLAYING' : 'READY TO LISTEN'}</span><span>{isPlaying ? 'Spanish commentary → Hindi' : 'Tap play to start live audio'}</span></div>
            <div className="language-dock"><div className="language-copy"><span className="language-icon"><Icon name="globe" size={19} /></span><div><small>LISTENING IN</small><strong>{selectedLanguage.native}</strong></div></div><div className="select-wrap"><select value={language} onChange={changeLanguage} aria-label="Commentary language">{languages.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select><Icon name="chevron" size={16} /></div></div>
          </article>

          <aside className="translation-card">
            <div className="card-eyebrow"><span><Icon name="spark" size={15} /> TRANSLATION PULSE</span><span className="ai-badge">AI</span></div>
            <div className="translation-status"><span className="pulse-ring"><i /></span><div><strong>Keeping up with the game</strong><small>Average translation latency: 0.8s</small></div></div>
            <div className="metric"><div><span>Commentary clarity</span><strong>98<span>%</span></strong></div><div className="progress"><i style={{ width: '98%' }} /></div></div>
            <div className="metric"><div><span>Moments translated</span><strong>248</strong></div><div className="progress rose"><i style={{ width: '76%' }} /></div></div>
            <div className="languages-live"><span>LANGUAGES LIVE</span><div><b>EN</b><b>ES</b><b>HI</b><b>FR</b><b>+12</b></div></div>
          </aside>
        </section>

        <section className="feed-section"><div className="feed-heading"><div><span className="section-kicker">THE LIVE FEED</span><h1>Every moment, made clear.</h1></div><button className="feed-action">View match center <Icon name="send" size={16} /></button></div><div className="feed-layout"><div className="feed-list">{liveText.length ? liveText.map((item) => <article className="feed-item" key={item.id}><span className="feed-time">{item.time}</span><p>{item.text}</p><span className="translated">Translated to {selectedLanguage.native}</span></article>) : <div className="empty-feed"><span className="pulse-ring"><i /></span><div><strong>Listening for the next moment</strong><p>Translated commentary will appear here as the match unfolds.</p></div></div>}</div><div className="moment-card"><span className="section-kicker">MATCH MOMENT</span><strong>Spain are pressing high.</strong><p>62% possession in the final 15 minutes.</p><div className="possession"><span style={{ width: '62%' }} /><i /></div><div><b>62% ESP</b><b>38% IND</b></div></div></div></section>
      </main>
      <div className="reactions" aria-hidden="true">{reactions.map((reaction) => <span key={reaction.id}>{reaction.emoji}</span>)}</div>
      <footer>STADIUMVOICE · ACCESSIBLE, BORDERLESS FOOTBALL <span>2026</span></footer>
    </div>
  );
}
