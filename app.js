const shit = 'QVEuQWI4Uk42THhjWnQ5ejJiaXhWRmwxWUFmZ29xZWhEVlA3Tms2a2ZqTS15Sm5fZG9mS1E=';
const API_KEY = atob(shit);
const MODEL_NAME = 'models/gemini-3.1-flash-live-preview';
const VOICE_NAME = 'Iapetus';

// Must use v1beta for gemini-3.1-flash-live-preview (matches google-genai SDK default in ass.py)
const GOOGLE_LIVE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(API_KEY)}`;

// PCM Conversions
function float32To16BitPCMBase64(input) {
  try {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const bytes = new Uint8Array(output.buffer);
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  } catch (err) {
    console.error('PCM encode error:', err);
    return '';
  }
}

function base64To16BitPCMFloat32(base64) {
  try {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const int16Array = new Int16Array(bytes.buffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768.0;
    }
    return float32Array;
  } catch (err) {
    console.error('PCM decode error:', err);
    return new Float32Array(0);
  }
}

// =========================================================
// AUDIO SYSTEM (Input: 16kHz Worklet/PCM, Output: 24kHz Live Audio)
// =========================================================
class AudioSystem {
  constructor() {
    this.outputCtx = null;
    this.analyser = null;
    this.gainNode = null;
    this.nextStartTime = 0;
    this.activeSources = [];
    this.freqData = null;

    this.micCtx = null;
    this.micStream = null;
    this.processor = null;
    this.workletNode = null;
    this.isListening = false;
    this.userMicLevel = 0;
    this.smoothedMicLevel = 0;
  }

  initOutput() {
    if (!this.outputCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      this.outputCtx = new AudioContextClass({ sampleRate: 24000 });
      this.gainNode = this.outputCtx.createGain();
      this.analyser = this.outputCtx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.38;
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);

      this.gainNode.connect(this.analyser);
      this.analyser.connect(this.outputCtx.destination);
      this.nextStartTime = this.outputCtx.currentTime;
    }
    if (this.outputCtx && this.outputCtx.state === 'suspended') {
      this.outputCtx.resume().catch(() => {});
    }
  }

  playChunk(base64Data) {
    try {
      this.initOutput();
      if (!this.outputCtx || !this.gainNode) return;

      const float32 = base64To16BitPCMFloat32(base64Data);
      if (!float32 || float32.length === 0) return;

      const buffer = this.outputCtx.createBuffer(1, float32.length, 24000);
      buffer.getChannelData(0).set(float32);

      const source = this.outputCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gainNode);

      const now = this.outputCtx.currentTime;
      const startTime = Math.max(now + 0.005, this.nextStartTime);
      source.start(startTime);
      this.nextStartTime = startTime + buffer.duration;

      this.activeSources.push(source);
      source.onended = () => {
        const idx = this.activeSources.indexOf(source);
        if (idx !== -1) this.activeSources.splice(idx, 1);
      };
    } catch (err) {
      console.warn('Audio play chunk warning:', err);
    }
  }

  stopAll() {
    for (const src of this.activeSources) {
      try {
        src.stop();
        src.disconnect();
      } catch (e) {}
    }
    this.activeSources = [];
    if (this.outputCtx) {
      this.nextStartTime = this.outputCtx.currentTime;
    }
  }

  isSpeaking() {
    if (!this.outputCtx) return false;
    return this.nextStartTime > this.outputCtx.currentTime || this.activeSources.length > 0;
  }

  getOutputVolume() {
    if (!this.analyser || !this.freqData) return 0;
    try {
      this.analyser.getByteFrequencyData(this.freqData);
      let sum = 0;
      for (let i = 0; i < this.freqData.length; i++) {
        sum += this.freqData[i];
      }
      return sum / (this.freqData.length * 255);
    } catch {
      return 0;
    }
  }

  getFrequencyBands(count = 48) {
    const bands = new Float32Array(count);
    if (!this.analyser || !this.freqData) return bands;
    this.analyser.getByteFrequencyData(this.freqData);
    const step = Math.max(1, Math.floor(this.freqData.length / count));
    for (let i = 0; i < count; i++) {
      bands[i] = (this.freqData[i * step] || 0) / 255;
    }
    return bands;
  }

  async startMicrophone(onAudioChunk) {
    if (this.isListening) return;
    try {
      this.initOutput();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this.micStream = stream;
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.micCtx = new AudioContextClass({ sampleRate: 16000 });
      const source = this.micCtx.createMediaStreamSource(stream);

      let workletLoaded = false;
      if (this.micCtx.audioWorklet && typeof Blob !== 'undefined') {
        try {
          const workletCode = `
            class MicCaptureProcessor extends AudioWorkletProcessor {
              process(inputs) {
                const input = inputs[0];
                if (input && input[0]) {
                  this.port.postMessage(input[0]);
                }
                return true;
              }
            }
            registerProcessor('mic-capture-processor', MicCaptureProcessor);
          `;
          const blob = new Blob([workletCode], { type: 'application/javascript' });
          const url = URL.createObjectURL(blob);
          await this.micCtx.audioWorklet.addModule(url);
          URL.revokeObjectURL(url);

          this.workletNode = new AudioWorkletNode(this.micCtx, 'mic-capture-processor');
          this.workletNode.port.onmessage = (ev) => {
            this.handleRawMicSamples(ev.data, onAudioChunk);
          };
          source.connect(this.workletNode);
          this.workletNode.connect(this.micCtx.destination);
          workletLoaded = true;
        } catch (wErr) {
          workletLoaded = false;
        }
      }

      if (!workletLoaded) {
        this.processor = this.micCtx.createScriptProcessor(4096, 1, 1);
        this.processor.onaudioprocess = (e) => {
          const inputData = e.inputBuffer.getChannelData(0);
          this.handleRawMicSamples(inputData, onAudioChunk);
        };
        source.connect(this.processor);
        this.processor.connect(this.micCtx.destination);
      }

      this.isListening = true;
    } catch (err) {
      console.warn('[Microphone] Access notice:', err?.message || err);
    }
  }

  handleRawMicSamples(inputData, onAudioChunk) {
    try {
      let sum = 0;
      for (let i = 0; i < inputData.length; i++) {
        sum += Math.abs(inputData[i]);
      }
      this.userMicLevel = Math.min(1, (sum / inputData.length) * 6.5);

      const base64PCM = float32To16BitPCMBase64(inputData);
      if (onAudioChunk && base64PCM) {
        onAudioChunk(base64PCM);
      }
    } catch (procErr) {
      console.warn('Process audio warning:', procErr);
    }
  }

  stopMicrophone() {
    if (this.workletNode) {
      try { this.workletNode.disconnect(); } catch (e) {}
      this.workletNode = null;
    }
    if (this.processor) {
      try { this.processor.disconnect(); } catch (e) {}
      this.processor = null;
    }
    if (this.micCtx) {
      try { this.micCtx.close(); } catch (e) {}
      this.micCtx = null;
    }
    if (this.micStream) {
      try {
        this.micStream.getTracks().forEach((track) => track.stop());
      } catch (e) {}
      this.micStream = null;
    }
    this.isListening = false;
    this.userMicLevel = 0;
  }
}

// Global instances & DOM references
const audio = new AudioSystem();
let ws = null;
let isSetupComplete = false;
let sessionHandle = null;
let hasSentInitialBoot = false;
let typedText = '';
let isReconnecting = false;
let pointerX = 0;
let pointerY = 0;
const pendingMessages = [];

const robotContainer = document.getElementById('robot-container');
const robotSvg = document.getElementById('robot-svg');
const visualizerCanvas = document.getElementById('visualizer-canvas');
const visualizerCtx = visualizerCanvas ? visualizerCanvas.getContext('2d') : null;
const ambientAura = document.getElementById('ambient-aura');
const listeningRing = document.getElementById('listening-ring');
const hWaveBars = document.querySelectorAll('.h-wave');
const earWaves = document.getElementById('ear-waves');
const foreheadPulse = document.getElementById('forehead-pulse');
const mouthCavity = document.getElementById('mouth-cavity');
const mouthGlow = document.getElementById('mouth-glow');
const mouthLine = document.getElementById('mouth-line');
const vocalBars = document.getElementById('vocal-bars');
const bars = document.querySelectorAll('.bar');
const leftEye = document.getElementById('left-eye');
const rightEye = document.getElementById('right-eye');
const leftIris = document.getElementById('left-iris');
const rightIris = document.getElementById('right-iris');
const leftPupil = document.getElementById('left-pupil');
const rightPupil = document.getElementById('right-pupil');
const captionStream = document.getElementById('caption-stream');
const typingLine = document.getElementById('typing-line');
const typingText = document.getElementById('typing-text');

// =========================================================
// WORD-BY-WORD AUDIO-SYNCED STREAMER WITH PHRASE GLIDE & FADE
// Shows each word one by one as the AI speaks, extending the line
// to 5-6 words before smoothly gliding the line upward and fading out
// =========================================================
class CaptionStreamer {
  constructor(container) {
    this.container = container;
    this.lines = [];
    this.currentLineEl = null;
    this.currentWordCount = 0;
    this.maxWordsPerLine = 6;
    this.partialToken = '';
    this.wordQueue = [];
    this.isRevealing = false;
    this.flushTimer = null;
    this.cleanupTimer = null;
  }

  addWords(chunkText) {
    if (!chunkText || !this.container) return;

    // Combine with any partial sub-word from the previous WebSocket frame
    const combined = this.partialToken + chunkText;
    const endsWithSpace = /\s$/.test(combined);
    const trimmed = combined.trimStart();
    if (!trimmed) {
      this.partialToken = '';
      return;
    }

    const parts = trimmed.split(/\s+/);
    const completeWords = endsWithSpace ? parts : parts.slice(0, -1);
    this.partialToken = endsWithSpace ? '' : parts[parts.length - 1] || '';

    for (const word of completeWords) {
      if (word) this.enqueueWord(word);
    }

    // Flush trailing word if stream pauses briefly
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flush();
    }, 260);

    this.scheduleCleanup();
  }

  flush() {
    if (this.partialToken.trim()) {
      this.enqueueWord(this.partialToken.trim());
      this.partialToken = '';
    }
  }

  enqueueWord(word) {
    this.wordQueue.push(word);
    if (!this.isRevealing) {
      this.processWordQueue();
    }
  }

  processWordQueue() {
    if (this.wordQueue.length === 0) {
      this.isRevealing = false;
      this.scheduleCleanup();
      return;
    }

    this.isRevealing = true;
    const nextWord = this.wordQueue.shift();
    this.appendSingleWord(nextWord);

    // Pace multi-word bursts so each word reveals one by one in sync with speech
    const delayMs = this.wordQueue.length > 4 ? 75 : 110;
    setTimeout(() => {
      this.processWordQueue();
    }, delayMs);
  }

  appendSingleWord(word) {
    if (!this.container) return;

    // Start the first line or glide up once the current line has extended to 5-6 words
    if (!this.currentLineEl || this.currentWordCount >= this.maxWordsPerLine) {
      this.glideLinesUpAndStartNew();
    }

    const span = document.createElement('span');
    span.className = 'word-span';
    span.textContent = word;
    this.currentLineEl.appendChild(span);
    this.currentWordCount++;

    // If a clause/sentence finishes after 4+ words, let the next word start a fresh line
    if (/[,.;:!?]$/.test(word) && this.currentWordCount >= 4) {
      this.currentWordCount = this.maxWordsPerLine;
    }
  }

  glideLinesUpAndStartNew() {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const line = this.lines[i];
      const age = this.lines.length - 1 - i + 1;

      line.classList.remove('active', 'step-1', 'step-2', 'step-3');

      if (age === 1) {
        line.classList.add('step-1');
      } else if (age === 2) {
        line.classList.add('step-2');
      } else {
        line.classList.add('step-3');
        setTimeout(() => {
          if (line.parentNode) line.parentNode.removeChild(line);
          const idx = this.lines.indexOf(line);
          if (idx !== -1) this.lines.splice(idx, 1);
        }, 680);
      }
    }

    const newLine = document.createElement('div');
    newLine.className = 'caption-line active';
    this.container.appendChild(newLine);
    this.lines.push(newLine);
    this.currentLineEl = newLine;
    this.currentWordCount = 0;
  }

  scheduleCleanup() {
    clearTimeout(this.cleanupTimer);
    this.cleanupTimer = setTimeout(() => {
      if (!audio.isSpeaking() && this.wordQueue.length === 0) {
        this.fadeAllLines();
      } else {
        this.scheduleCleanup();
      }
    }, 3800);
  }

  fadeAllLines() {
    this.lines.forEach((line) => {
      line.classList.remove('active', 'step-1', 'step-2');
      line.classList.add('step-3');
      setTimeout(() => {
        if (line.parentNode) line.parentNode.removeChild(line);
      }, 680);
    });
    this.lines = [];
    this.currentLineEl = null;
    this.currentWordCount = 0;
  }

  clear() {
    clearTimeout(this.flushTimer);
    clearTimeout(this.cleanupTimer);
    this.partialToken = '';
    this.wordQueue = [];
    this.isRevealing = false;
    this.fadeAllLines();
  }
}

const captions = new CaptionStreamer(captionStream);

// =========================================================
// DIRECT BROWSER-TO-GEMINI v1beta LIVE WEBSOCKET (MATCHING ass.py)
// Strictly waits for setupComplete before streaming audio/text
// =========================================================
function connectDirectToGoogle() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  isSetupComplete = false;

  try {
    ws = new WebSocket(GOOGLE_LIVE_WS_URL);

    ws.onopen = () => {
      console.log(`[Gemini Live v1beta] Socket opened. Sending setup for ${MODEL_NAME} (Voice: ${VOICE_NAME})...`);
      isReconnecting = false;

      const setupConfig = {
        model: MODEL_NAME,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: VOICE_NAME,
              },
            },
          },
        },
        outputAudioTranscription: {},
        systemInstruction: {
          parts: [
            {
              text: `You are a friendly ai, tujhe urdu/hindi main baat krni hai user sy, Now give a warm welcome to the user`,
            },
          ],
        },
      };

      if (sessionHandle) {
        setupConfig.sessionResumption = { handle: sessionHandle };
      } else {
        setupConfig.sessionResumption = {};
      }

      ws.send(JSON.stringify({ setup: setupConfig }));
    };

    ws.onmessage = async (event) => {
      try {
        let rawData = event.data;
        if (rawData instanceof Blob) {
          rawData = await rawData.text();
        } else if (rawData instanceof ArrayBuffer) {
          rawData = new TextDecoder().decode(rawData);
        }

        const msg = JSON.parse(rawData);

        // 1. Handshake complete: ONLY now is it valid to send clientContent or realtimeInput
        if (msg.setupComplete !== undefined) {
          console.log('[Gemini Live v1beta] setupComplete received — session is LIVE.');
          isSetupComplete = true;

          // Flush any user messages typed while connecting
          while (pendingMessages.length > 0) {
            const pending = pendingMessages.shift();
            doSendText(pending);
          }

          // Just like ass.py, greet briefly on initial session boot if no pending message
          if (!hasSentInitialBoot && !sessionHandle) {
            hasSentInitialBoot = true;
            doSendText(' Please give me a very brief, friendly welcome.');
          }
          return;
        }

        // 2. Session Resumption Handle update (matches ass.py)
        if (msg.sessionResumptionUpdate) {
          const update = msg.sessionResumptionUpdate;
          if (update.resumable && update.newHandle) {
            sessionHandle = update.newHandle;
          }
        }

        // 3. Proactive GoAway reconnect (matches ass.py)
        if (msg.goAway) {
          console.log('[Gemini Live v1beta] Server sent GoAway, reconnecting...');
          try {
            ws.close();
          } catch (e) {}
          return;
        }

        // 4. Server Content (Audio + Output Transcription)
        if (msg.serverContent) {
          const sc = msg.serverContent;

          if (sc.interrupted) {
            audio.stopAll();
            captions.clear();
          }

          const outTranscript = sc.outputTranscription;
          if (outTranscript && outTranscript.text) {
            captions.addWords(outTranscript.text);
          }

          if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
            for (const part of sc.modelTurn.parts) {
              if (part.inlineData?.data) {
                audio.playChunk(part.inlineData.data);
              }
            }
          }

          if (sc.turnComplete) {
            captions.flush();
          }
        }
      } catch (err) {
        console.warn('[Direct Live Message Warning]:', err);
      }
    };

    ws.onerror = (e) => {
      console.warn('[Direct Live WS Error]:', e);
    };

    ws.onclose = (event) => {
      console.log(`[Direct Live WS Closed] code=${event.code} reason=${event.reason || 'none'}`);
      isSetupComplete = false;
      if (event.code === 1007 || event.code === 1008) {
        sessionHandle = null;
      }
      if (!isReconnecting) {
        isReconnecting = true;
        setTimeout(connectDirectToGoogle, 2500);
      }
    };
  } catch (err) {
    console.error('[Direct Live Connect Error]:', err);
  }
}

connectDirectToGoogle();

function doSendText(text) {
  if (!text || !text.trim() || !ws || ws.readyState !== WebSocket.OPEN || !isSetupComplete) return;
  const clientContentMessage = {
    clientContent: {
      turns: [
        {
          role: 'user',
          parts: [{ text: text.trim() }],
        },
      ],
      turnComplete: true,
    },
  };
  ws.send(JSON.stringify(clientContentMessage));
}

function sendText(text) {
  if (!text || !text.trim()) return;
  audio.initOutput();

  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    connectDirectToGoogle();
  }

  if (ws && ws.readyState === WebSocket.OPEN && isSetupComplete) {
    doSendText(text);
  } else {
    pendingMessages.push(text.trim());
  }
}

// Send mic chunk using non-deprecated realtimeInput.audio (matches ass.py & v1beta spec)
// Strictly gated on isSetupComplete so audio never interrupts the initial setup handshake
function sendAudioChunk(base64Data) {
  if (ws && ws.readyState === WebSocket.OPEN && isSetupComplete) {
    const realtimeInputMessage = {
      realtimeInput: {
        audio: {
          data: base64Data,
          mimeType: 'audio/pcm;rate=16000',
        },
      },
    };
    ws.send(JSON.stringify(realtimeInputMessage));
  }
}

function ensureLiveMic() {
  audio.initOutput();
  audio.startMicrophone(sendAudioChunk);
}

// Silent gesture unlock for browser AudioContext & Microphone (no visual click bounce)
window.addEventListener('click', ensureLiveMic, { once: true });
window.addEventListener('touchstart', ensureLiveMic, { once: true });
window.addEventListener('keydown', ensureLiveMic, { once: true });

// Pointer Eye Tracking
window.addEventListener('mousemove', (e) => {
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2 - 30;
  pointerX = Math.max(-1, Math.min(1, (e.clientX - cx) / (window.innerWidth * 0.4)));
  pointerY = Math.max(-1, Math.min(1, (e.clientY - cy) / (window.innerHeight * 0.4)));
});

// Floating Live Invisible Text Typer (Appears only while typing on keyboard, no chatbox)
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.key === 'Enter') {
    if (typedText.trim()) {
      sendText(typedText);
      typedText = '';
      if (typingLine) typingLine.classList.add('hidden');
    }
  } else if (e.key === 'Backspace') {
    typedText = typedText.slice(0, -1);
    if (typedText.length === 0) {
      if (typingLine) typingLine.classList.add('hidden');
    } else {
      if (typingText) typingText.textContent = typedText;
    }
  } else if (e.key === 'Escape') {
    typedText = '';
    if (typingLine) typingLine.classList.add('hidden');
    if (audio.isSpeaking()) {
      audio.stopAll();
      captions.clear();
      if (ws && ws.readyState === WebSocket.OPEN && isSetupComplete) {
        ws.send(JSON.stringify({ clientContent: { turnComplete: true } }));
      }
    }
  } else if (e.key.length === 1) {
    typedText += e.key;
    if (typingText) typingText.textContent = typedText;
    if (typingLine) typingLine.classList.remove('hidden');
  }
});

// Procedural Blinking
let isBlinking = false;
function scheduleBlink() {
  const timeout = 2200 + Math.random() * 3200;
  setTimeout(() => {
    isBlinking = true;
    setTimeout(() => {
      isBlinking = false;
      scheduleBlink();
    }, 135);
  }, timeout);
}
scheduleBlink();

// =========================================================
// 2D CANVAS RADIAL FFT SPECTRUM & ORBITAL PARTICLE ENGINE
// =========================================================
const ORBIT_PARTICLES = Array.from({ length: 28 }, (_, i) => ({
  angle: (i / 28) * Math.PI * 2,
  radius: 132 + (i % 4) * 16,
  speed: (0.004 + (i % 5) * 0.0018) * (i % 2 === 0 ? 1 : -1),
  size: 1.5 + (i % 3) * 0.9,
}));

function renderVisualizerCanvas(time, speaking, isHearing, vol, micLevel) {
  if (!visualizerCtx || !visualizerCanvas) return;
  const w = visualizerCanvas.width;
  const h = visualizerCanvas.height;
  const cx = w / 2;
  const cy = h / 2;

  visualizerCtx.clearRect(0, 0, w, h);

  const activeEnergy = speaking ? vol : isHearing ? micLevel : 0.04;
  const primaryColor = isHearing
    ? '16, 185, 129'
    : speaking
    ? '56, 189, 248'
    : '99, 102, 241';

  visualizerCtx.save();
  visualizerCtx.beginPath();
  const baseRadius = 122 + activeEnergy * 28;
  visualizerCtx.arc(cx, cy, baseRadius, 0, Math.PI * 2);
  visualizerCtx.strokeStyle = `rgba(${primaryColor}, ${0.18 + activeEnergy * 0.45})`;
  visualizerCtx.lineWidth = 1.5;
  visualizerCtx.stroke();

  const bandCount = 48;
  const bands = speaking ? audio.getFrequencyBands(bandCount) : null;
  for (let i = 0; i < bandCount; i++) {
    const angle = (i / bandCount) * Math.PI * 2 - Math.PI / 2;
    let amp = 0.04;
    if (speaking && bands) {
      amp = bands[i] * 0.85 + Math.sin(time * 8 + i * 0.4) * 0.08;
    } else if (isHearing) {
      amp = micLevel * (0.5 + 0.5 * Math.sin(time * 10 + i * 0.5));
    } else {
      amp = 0.04 + 0.025 * Math.sin(time * 2 + i * 0.3);
    }

    const innerR = 126;
    const barLen = 4 + Math.max(0, amp * 44);
    const x1 = cx + Math.cos(angle) * innerR;
    const y1 = cy + Math.sin(angle) * innerR;
    const x2 = cx + Math.cos(angle) * (innerR + barLen);
    const y2 = cy + Math.sin(angle) * (innerR + barLen);

    visualizerCtx.beginPath();
    visualizerCtx.moveTo(x1, y1);
    visualizerCtx.lineTo(x2, y2);
    visualizerCtx.strokeStyle = `rgba(${primaryColor}, ${0.22 + Math.min(0.75, amp)})`;
    visualizerCtx.lineWidth = 2.6;
    visualizerCtx.lineCap = 'round';
    visualizerCtx.stroke();
  }

  for (const p of ORBIT_PARTICLES) {
    p.angle += p.speed * (1 + activeEnergy * 3.2);
    const r = p.radius + Math.sin(time * 2 + p.angle * 2) * (4 + activeEnergy * 14);
    const px = cx + Math.cos(p.angle) * r;
    const py = cy + Math.sin(p.angle) * r;

    visualizerCtx.beginPath();
    visualizerCtx.arc(px, py, p.size + activeEnergy * 1.4, 0, Math.PI * 2);
    visualizerCtx.fillStyle = `rgba(${primaryColor}, ${0.35 + activeEnergy * 0.5})`;
    visualizerCtx.fill();
  }

  visualizerCtx.restore();
}

// =========================================================
// 60FPS SPEAKING, HEARING & EYE-TRACKING ANIMATION LOOP
// =========================================================
let smoothedVol = 0;
let time = 0;

function animate() {
  time += 0.04;

  const speaking = audio.isSpeaking();
  const rawVol = speaking ? audio.getOutputVolume() : 0;
  smoothedVol += (rawVol - smoothedVol) * 0.32;
  const vol = smoothedVol;

  audio.smoothedMicLevel += (audio.userMicLevel - audio.smoothedMicLevel) * 0.35;
  const micLevel = audio.smoothedMicLevel;
  const isHearing = audio.isListening && micLevel > 0.025;

  renderVisualizerCanvas(time, speaking, isHearing, vol, micLevel);

  // 1. "AI IS HEARING" VISUAL EFFECTS
  if (robotContainer) {
    robotContainer.classList.toggle('speaking', speaking);

    if (isHearing && !speaking) {
      robotContainer.classList.add('hearing');

      const waveOpacity = Math.min(1, micLevel * 2.8);
      if (earWaves) earWaves.style.opacity = waveOpacity.toString();

      if (foreheadPulse) {
        foreheadPulse.setAttribute('opacity', (waveOpacity * 0.85).toString());
        foreheadPulse.setAttribute('r', (4 + micLevel * 9).toString());
      }

      if (leftIris) leftIris.setAttribute('fill', '#34d399');
      if (rightIris) rightIris.setAttribute('fill', '#34d399');

      hWaveBars.forEach((bar, i) => {
        const h = 4 + Math.sin(time * 12 + i * 1.3) * 7 * micLevel + micLevel * 16;
        bar.style.height = `${Math.max(4, h)}px`;
      });

      if (listeningRing) listeningRing.classList.add('active');
    } else {
      robotContainer.classList.remove('hearing');
      if (earWaves) earWaves.style.opacity = '0';
      if (foreheadPulse) foreheadPulse.setAttribute('opacity', '0');
      if (listeningRing) listeningRing.classList.remove('active');

      if (!speaking) {
        if (leftIris) leftIris.setAttribute('fill', '#38bdf8');
        if (rightIris) rightIris.setAttribute('fill', '#38bdf8');
      }
    }
  }

  // 2. SINGLE SPEAKING MOUTH ANIMATION
  if (speaking && vol > 0.015) {
    const wave = Math.sin(time * 15) * 0.22;
    const mouthHeight = Math.max(4, Math.min(46, 6 + vol * 48 + wave * 5));
    const mouthWidth = Math.max(38, Math.min(76, 46 + vol * 24));

    if (mouthCavity) {
      mouthCavity.setAttribute('rx', (mouthWidth / 2).toString());
      mouthCavity.setAttribute('ry', (mouthHeight / 2).toString());
      mouthCavity.setAttribute('opacity', '1');
    }

    if (mouthGlow) {
      mouthGlow.setAttribute('rx', (mouthWidth / 2.8).toString());
      mouthGlow.setAttribute('ry', (mouthHeight / 2.8).toString());
      mouthGlow.setAttribute('opacity', '0.55');
    }

    if (mouthLine) {
      mouthLine.setAttribute(
        'd',
        `M -${mouthWidth / 2} 0 Q 0 ${mouthHeight / 2 + 3} ${mouthWidth / 2} 0`
      );
    }

    if (vocalBars) vocalBars.classList.add('speaking');
    bars.forEach((bar, i) => {
      const barH = 6 + Math.sin(time * 11 + i * 0.9) * 12 * vol + vol * 18;
      bar.style.height = `${Math.max(4, barH)}px`;
    });

    const swayX = Math.sin(time * 3.2) * 2.2 * vol;
    const swayY = Math.cos(time * 4.2) * 2.6 * vol;
    if (robotSvg) robotSvg.style.transform = `translate(${swayX}px, ${swayY}px)`;
  } else {
    if (mouthCavity) mouthCavity.setAttribute('opacity', '0');
    if (mouthGlow) mouthGlow.setAttribute('opacity', '0');
    if (mouthLine) mouthLine.setAttribute('d', 'M -22 0 Q 0 2.8 22 0');
    if (vocalBars) vocalBars.classList.remove('speaking');

    const breatheX = Math.sin(time * 0.8) * 1.2;
    const breatheY = Math.cos(time * 0.6) * 1.8;
    if (robotSvg) robotSvg.style.transform = `translate(${breatheX}px, ${breatheY}px)`;
  }

  // 3. Eye Blinking & Cursor Tracking
  const lookX = (pointerX * 3.6).toFixed(2);
  const lookY = (pointerY * 2.8).toFixed(2);
  if (leftIris && rightIris && leftPupil && rightPupil) {
    leftIris.setAttribute('cx', lookX);
    leftIris.setAttribute('cy', lookY);
    rightIris.setAttribute('cx', lookX);
    rightIris.setAttribute('cy', lookY);
    leftPupil.setAttribute('cx', (pointerX * 4.5).toFixed(2));
    leftPupil.setAttribute('cy', (pointerY * 3.4).toFixed(2));
    rightPupil.setAttribute('cx', (pointerX * 4.5).toFixed(2));
    rightPupil.setAttribute('cy', (pointerY * 3.4).toFixed(2));
  }

  if (leftEye && rightEye) {
    if (isBlinking) {
      leftEye.setAttribute('transform', 'translate(88, 88) scale(1, 0.08)');
      rightEye.setAttribute('transform', 'translate(152, 88) scale(1, 0.08)');
    } else {
      leftEye.setAttribute('transform', 'translate(88, 88) scale(1, 1)');
      rightEye.setAttribute('transform', 'translate(152, 88) scale(1, 1)');
    }
  }

  // 4. Background Ambient Halo Scale
  if (ambientAura) {
    const auraScale = 1 + (speaking ? vol * 0.48 : isHearing ? micLevel * 0.4 : 0.05);
    ambientAura.style.transform = `scale(${auraScale})`;
  }

  requestAnimationFrame(animate);
}

requestAnimationFrame(animate);
