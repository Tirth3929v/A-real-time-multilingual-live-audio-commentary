import React, { useState, useEffect, useRef } from 'react';
import './index.css';

const EMOJIS = ['🔥', '⚽', '🤯', '👏', '🇪🇸', '🇮🇳', '🎉'];

export default function App() {
  const [language, setLanguage] = useState('hi'); // Default to Hindi
  const [isPlaying, setIsPlaying] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [liveText, setLiveText] = useState([]);
  const [reactions, setReactions] = useState([]);
  
  const wsRef = useRef(null);
  const isPlayingRef = useRef(isPlaying);
  const languageRef = useRef(language);

  // Sync refs to prevent stale closure issues in WebSocket callbacks
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    languageRef.current = language;
  }, [language]);
  
  // 1. Establish WebSocket Connection ONCE on load
  useEffect(() => {
    // Connect to your Node.js orchestrator (Port 3001)
    wsRef.current = new WebSocket('ws://localhost:3001');

    wsRef.current.onopen = () => {
      console.log('🟢 Connected to Node.js Orchestrator');
      setIsConnected(true);
      // Join specific language room on connect
      wsRef.current.send(JSON.stringify({ type: 'join_room', language: languageRef.current }));
    };

    wsRef.current.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        // Handle Welcome / Room Join messages
        if (data.type === 'text' && data.payload) {
          setLiveText(prev => {
             const newFeed = [{ id: data.seqId || Date.now(), time: 'SYS', text: data.payload }, ...prev];
             return newFeed.slice(0, 10);
          });
        }
        
        // Always store the latest text, regardless of audio state
        if (data.translatedText) {
          setLiveText(prev => [
            { id: data.sequenceId || Date.now(), time: "LIVE", text: data.translatedText },
            ...prev
          ].slice(0, 10));
        }

        // Store the audio buffer in a separate state so we can play it if isPlaying is true
        if (data.audioBuffer) {
           handleIncomingAudio(data.audioBuffer);
        }

      } catch (error) {
        console.error("Error parsing live stream data:", error);
      }
    };

    wsRef.current.onclose = () => {
      console.log('Disconnected from server');
      setIsConnected(false);
    };

    return () => {
      if (wsRef.current) {
        console.log("Cleaning up WebSocket...");
        wsRef.current.close();
      }
    };
  }, []); // Empty dependency array is correct now as refs are used

  const handleIncomingAudio = (base64Audio) => {
    if (isPlayingRef.current) {
      // WAV files start with 'RIFF' -> base64 'UklGR'
      const isWav = base64Audio.startsWith('UklGR');
      const mimeType = isWav ? 'audio/wav' : 'audio/mp3';
      const audioSrc = `data:${mimeType};base64,${base64Audio}`;
      const audio = new Audio(audioSrc);
      
      audio.play().catch(err => {
        console.error("Browser blocked audio playback (Click play first!):", err);
      });
    }
  };

  // Simulate live fan reactions while audio is playing
  useEffect(() => {
    if (!isPlaying) return;

    const interval = setInterval(() => {
      if (Math.random() > 0.3) {
        const newReaction = {
          id: Date.now(),
          emoji: EMOJIS[Math.floor(Math.random() * EMOJIS.length)],
          leftOffset: Math.random() * 20 - 10
        };
        
        setReactions(prev => [...prev, newReaction]);

        setTimeout(() => {
          setReactions(prev => prev.filter(r => r.id !== newReaction.id));
        }, 2500);
      }
    }, 600);

    return () => clearInterval(interval);
  }, [isPlaying]);

  const handleLanguageChange = (e) => {
    const newLang = e.target.value;
    setLanguage(newLang);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'join_room', language: newLang }));
    }
  };

  const togglePlay = () => {
    setIsPlaying(!isPlaying);
  };

  return (
    <div className="dashboard-container" style={{ position: 'relative' }}>
      
      {/* Ambient Animated Background Blobs */}
      <div className="bg-blob blob-1"></div>
      <div className="bg-blob blob-2"></div>

      {/* Floating Fan Reactions */}
      <div className="reactions-container">
        {reactions.map(reaction => (
          <div 
            key={reaction.id} 
            className="reaction-emoji"
            style={{ left: `calc(50% + ${reaction.leftOffset}px)` }}
          >
            {reaction.emoji}
          </div>
        ))}
      </div>

      {/* Header */}
      <header className="header">
        <h1>GlobalMatch AI</h1>
        
        {/* Glowing Scoreboard */}
        <div className="scoreboard">
          <span className="team-name">Team A</span>
          <span className="score">2 - 1</span>
          <span className="team-name">Team B</span>
        </div>

        <div style={{display: 'flex', gap: '1rem', alignItems: 'center'}}>
          <div className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
            <div className="live-indicator" style={{ 
              backgroundColor: isConnected ? '#10b981' : '#ef4444', 
              boxShadow: isConnected ? '0 0 8px #10b981' : '0 0 8px #ef4444',
              animation: isConnected ? 'pulse 2s infinite' : 'none'
            }}></div>
            {isConnected ? 'Connected' : 'Disconnected'}
          </div>
          <select 
            className="language-selector"
            value={language}
            onChange={handleLanguageChange}
          >
            <option value="en">English</option>
            <option value="es">Español</option>
            <option value="fr">Français</option>
            <option value="hi">Hindi (हिन्दी)</option>
            <option value="gu">Gujarati (ગુજરાતી)</option>
          </select>
        </div>
      </header>

      {/* Main Grid */}
      <main className="main-content">
        
        {/* Left Column: Audio & Commentary */}
        <section className="glass-panel">
          <div className="panel-title">
            <div className="live-indicator"></div>
            Live Audio Stream
          </div>
          
          <div className="audio-player">
            <button className="play-btn" onClick={togglePlay}>
              {isPlaying ? '⏸' : '▶'}
            </button>
            <div className="visualizer">
              {/* Dynamic Waveform Simulation */}
              {[...Array(20)].map((_, i) => (
                <div 
                  key={i} 
                  className="visualizer-bar" 
                  style={{ 
                    height: isPlaying ? `${20 + Math.random() * 80}%` : '10%',
                    animationDuration: `${0.2 + Math.random() * 0.3}s`,
                    animationPlayState: isPlaying ? 'running' : 'paused'
                  }}
                ></div>
              ))}
            </div>
          </div>

          <div className="panel-title" style={{ marginTop: '1rem' }}>
            Live Text Feed
          </div>
          <div className="commentary-feed">
            {liveText.length === 0 ? (
              <div style={{color: 'var(--text-secondary)', fontStyle: 'italic', padding: '1rem'}}>
                Waiting for commentary...
              </div>
            ) : (
              liveText.map(item => (
                <div key={item.id} className="commentary-item">
                  <div className="commentary-meta">{item.time}</div>
                  <div>{item.text}</div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Right Column: Analytics */}
        <section className="glass-panel">
          <div className="panel-title">
            Match Analytics
          </div>

          <div className="stat-row">
            <div className="stat-header">
              <span>Team A</span>
              <span style={{ color: 'var(--text-secondary)' }}>Possession</span>
              <span>Team B</span>
            </div>
            <div className="stat-bar-container">
              <div className="stat-bar-team-a" style={{ width: '60%' }}></div>
              <div className="stat-bar-team-b" style={{ width: '40%' }}></div>
            </div>
            <div className="stat-header" style={{ marginTop: '4px' }}>
              <span>60%</span>
              <span>40%</span>
            </div>
          </div>

          {/* New Circular Stats Widget */}
          <div className="stats-grid">
            <div className="stat-circle-card">
              <svg className="circle-svg">
                <circle className="bg" cx="40" cy="40" r="32"></circle>
                <circle className="progress" cx="40" cy="40" r="32" style={{strokeDashoffset: isPlaying ? 30 : 200}}></circle>
              </svg>
              <div className="circle-value">85%</div>
              <div className="circle-label">Pass Accuracy</div>
            </div>
            <div className="stat-circle-card">
              <svg className="circle-svg">
                <circle className="bg" cx="40" cy="40" r="32"></circle>
                <circle className="progress" cx="40" cy="40" r="32" style={{strokeDashoffset: isPlaying ? 70 : 200, stroke: '#f43f5e'}}></circle>
              </svg>
              <div className="circle-value">65%</div>
              <div className="circle-label">Tackle Success</div>
            </div>
          </div>
          
        </section>
      </main>
    </div>
  );
}
