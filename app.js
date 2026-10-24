const shit = 'QVEuQWI4Uk42THhjWnQ5ejJiaXhWRmwxWUFmZ29xZWhEVlA3Tms2a2ZqTS15Sm5fZG9mS1E=';
const API_KEY = atob(shit);

// Model and Voice strictly preserved
const MODEL_NAME = 'models/gemini-3.1-flash-live-preview';
const VOICE_NAME = 'Iapetus';
const GOOGLE_LIVE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(API_KEY)}`;

// Session Resumption Cache Constants
const SESSION_CACHE_KEY = 'Novax_gemini_session_handle_v1';
const SESSION_TTL_MS = 1000 * 60 * 15; // 15-minute validity

// Audio PCM conversions
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
// BACKGROUND SESSION RESUMPTION VAULT
// =========================================================
class SessionVault {
  static getValidHandle() {
    try {
      const raw = localStorage.getItem(SESSION_CACHE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (data && data.handle && typeof data.timestamp === 'number') {
        const age = Date.now() - data.timestamp;
        if (age < SESSION_TTL_MS) {
          return data.handle;
        }
      }
      this.clear();
      return null;
    } catch {
      this.clear();
      return null;
    }
  }

  static storeHandle(handle) {
    if (!handle) return;
    try {
      localStorage.setItem(
        SESSION_CACHE_KEY,
        JSON.stringify({
          handle: handle,
          timestamp: Date.now(),
        })
      );
    } catch (e) {
      console.warn('[SessionVault] Failed to save session handle:', e);
    }
  }

  static clear() {
    try {
      localStorage.removeItem(SESSION_CACHE_KEY);
    } catch {}
  }
}

// =========================================================
// AUDIO SYSTEM (16kHz Buffered Input, 24kHz Live Output)
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

    // Buffers worklet frames to 128ms packets to prevent websocket flooding
    this.audioBuffer = [];
    this.targetChunkSize = 2048;
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
      console.warn('Audio play warning:', err);
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

  async startMicrophone(onAudioChunk) {
    if (this.isListening) return;
    try {
      this.initOutput();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;

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
        } catch {
          workletLoaded = false;
        }
      }

      if (!workletLoaded) {
        this.processor = this.micCtx.createScriptProcessor(2048, 1, 1);
        this.processor.onaudioprocess = (e) => {
          const inputData = e.inputBuffer.getChannelData(0);
          this.handleRawMicSamples(inputData, onAudioChunk);
        };
        source.connect(this.processor);
        this.processor.connect(this.micCtx.destination);
      }

      this.isListening = true;
    } catch (err) {
      console.warn('[Microphone] Notice:', err?.message || err);
    }
  }

  handleRawMicSamples(inputData, onAudioChunk) {
    try {
      let sum = 0;
      for (let i = 0; i < inputData.length; i++) {
        sum += Math.abs(inputData[i]);
        this.audioBuffer.push(inputData[i]);
      }
      this.userMicLevel = Math.min(1, (sum / inputData.length) * 6.5);

      if (this.audioBuffer.length >= this.targetChunkSize) {
        const floatArray = new Float32Array(this.audioBuffer);
        this.audioBuffer = [];
        const base64PCM = float32To16BitPCMBase64(floatArray);
        if (onAudioChunk && base64PCM) {
          onAudioChunk(base64PCM);
        }
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
      try { this.micStream.getTracks().forEach((track) => track.stop()); } catch (e) {}
      this.micStream = null;
    }
    this.isListening = false;
    this.userMicLevel = 0;
    this.audioBuffer = [];
  }
}

// Global Variables
const audio = new AudioSystem();
let ws = null;
let isSetupComplete = false;
let sessionHandle = SessionVault.getValidHandle();
let hasSentInitialBoot = false;
let pointerX = 0;
let pointerY = 0;
let isReconnecting = false;
const pendingMessages = [];

// DOM References
const monolithStage = document.getElementById('monolith-stage');
const monolithSvg = document.getElementById('monolith-svg');
const ambientFog = document.getElementById('ambient-fog');
const acousticRing = document.getElementById('acoustic-ring');
const meterBars = document.querySelectorAll('.meter-bar');
const lateralWaves = document.getElementById('lateral-waves');
const foreheadRipple = document.getElementById('forehead-ripple');
const apertureDepth = document.getElementById('aperture-depth');
const apertureLum = document.getElementById('aperture-lum');
const apertureSlit = document.getElementById('aperture-slit');
const vocalSpectrogram = document.getElementById('vocal-spectrogram');
const vocalBars = document.querySelectorAll('.vocal-bar');
const opticalL = document.getElementById('optical-l');
const opticalR = document.getElementById('optical-r');
const irisL = document.getElementById('iris-l');
const irisR = document.getElementById('iris-r');
const pupilL = document.getElementById('pupil-l');
const pupilR = document.getElementById('pupil-r');

// Dialogue References
const userStatement = document.getElementById('user-statement');
const userBody = document.getElementById('user-body');
const aiStatement = document.getElementById('ai-statement');
const aiBody = document.getElementById('ai-body');

// Controls & Keyboard References
const omniInput = document.getElementById('omni-input');
const ghostTyping = document.getElementById('ghost-typing');
const ghostChars = document.getElementById('ghost-chars');
const btnCamera = document.getElementById('btn-camera');
const btnMic = document.getElementById('btn-mic');
const btnResetSession = document.getElementById('btn-reset-session');

// Camera References
const cameraFrame = document.getElementById('camera-frame');
const cameraFeed = document.getElementById('camera-feed');
const btnExpandCam = document.getElementById('btn-expand-cam');
const btnRotateCam = document.getElementById('btn-rotate-cam');
const expandIcon = document.getElementById('expand-icon');
const collapseIcon = document.getElementById('collapse-icon');
const offscreenCanvas = document.createElement('canvas');

let camStream = null;
let camInterval = null;
let isCamActive = false;
let isCamExpanded = false;
let currentFacingMode = 'user'; // 'user' (front) or 'environment' (back)

// =========================================================
// 1-TO-1 DIALOGUE MANAGER
// =========================================================
class DialogueEngine {
  constructor() {
    this.currentAiText = '';
    this.userDismissTimer = null;
    this.aiDismissTimer = null;
  }

  showUser(text) {
    if (!text || !text.trim()) return;
    clearTimeout(this.userDismissTimer);
    userBody.textContent = text.trim();
    userStatement.classList.remove('hidden');

    this.userDismissTimer = setTimeout(() => {
      userStatement.classList.add('hidden');
    }, 7500);
  }

  beginAiTurn() {
    clearTimeout(this.aiDismissTimer);
    this.currentAiText = '';
    aiBody.textContent = '';
    aiStatement.classList.remove('hidden');
  }

  feedAiTranscript(chunk) {
    if (!chunk) return;
    this.currentAiText += chunk;
    aiBody.textContent = this.currentAiText;
    aiStatement.classList.remove('hidden');
    clearTimeout(this.aiDismissTimer);
  }

  concludeAiTurn() {
    clearTimeout(this.aiDismissTimer);
    this.aiDismissTimer = setTimeout(() => {
      if (!audio.isSpeaking()) {
        aiStatement.classList.add('hidden');
      }
    }, 7000);
  }

  purge() {
    userStatement.classList.add('hidden');
    aiStatement.classList.add('hidden');
    this.currentAiText = '';
  }
}

const dialogue = new DialogueEngine();

// =========================================================
// OPTICAL VIEWPORT (EXPANDABLE & ROTATABLE)
// =========================================================
async function toggleCamera() {
  if (isCamActive) {
    shutCamera();
  } else {
    await bootCamera();
  }
}

async function bootCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: currentFacingMode,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 60, min: 30 },
      },
    });

    camStream = stream;
    cameraFeed.srcObject = stream;

    // Apply mirror flip only for front camera
    if (currentFacingMode === 'user') {
      cameraFeed.classList.add('mirrored');
    } else {
      cameraFeed.classList.remove('mirrored');
    }

    cameraFrame.classList.remove('hidden');
    btnCamera.classList.add('active');
    isCamActive = true;

    // Send exactly 1 frame per second to AI to preserve bandwidth
    camInterval = setInterval(broadcastFrame, 1000);
  } catch (err) {
    console.warn('[Camera] Access notice:', err?.message || err);
  }
}

function shutCamera() {
  if (camInterval) {
    clearInterval(camInterval);
    camInterval = null;
  }
  if (camStream) {
    camStream.getTracks().forEach((track) => track.stop());
    camStream = null;
  }
  cameraFrame.classList.add('hidden');
  cameraFrame.classList.remove('expanded');
  isCamExpanded = false;
  btnRotateCam.classList.add('hidden');
  expandIcon.classList.remove('hidden');
  collapseIcon.classList.add('hidden');
  btnCamera.classList.remove('active');
  isCamActive = false;
}

async function rotateCamera() {
  currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
  if (camStream) {
    camStream.getTracks().forEach((track) => track.stop());
    camStream = null;
  }
  await bootCamera();
}

function toggleExpandCamera() {
  isCamExpanded = !isCamExpanded;
  cameraFrame.classList.toggle('expanded', isCamExpanded);

  if (isCamExpanded) {
    btnRotateCam.classList.remove('hidden');
    expandIcon.classList.add('hidden');
    collapseIcon.classList.remove('hidden');
  } else {
    btnRotateCam.classList.add('hidden');
    expandIcon.classList.remove('hidden');
    collapseIcon.classList.add('hidden');
  }
}

btnExpandCam.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleExpandCamera();
});

btnRotateCam.addEventListener('click', (e) => {
  e.stopPropagation();
  rotateCamera();
});

function broadcastFrame() {
  if (!isCamActive || !cameraFeed.videoWidth || !ws || ws.readyState !== WebSocket.OPEN || !isSetupComplete) {
    return;
  }

  const ctx = offscreenCanvas.getContext('2d');
  const targetW = 480;
  const targetH = Math.round((cameraFeed.videoHeight / cameraFeed.videoWidth) * targetW) || 360;

  offscreenCanvas.width = targetW;
  offscreenCanvas.height = targetH;
  ctx.drawImage(cameraFeed, 0, 0, targetW, targetH);

  const base64Jpeg = offscreenCanvas.toDataURL('image/jpeg', 0.72).split(',')[1];
  if (!base64Jpeg || base64Jpeg.length < 200) return;

  const framePayload = {
    realtimeInput: {
      video: {
        mimeType: 'image/jpeg',
        data: base64Jpeg,
      },
    },
  };
  ws.send(JSON.stringify(framePayload));
}

// =========================================================
// GEMINI LIVE WEBSOCKET CONNECTION
// Grabs user speech transcript via inputAudioTranscription
// =========================================================
function connectLiveGateway() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  isSetupComplete = false;

  try {
    ws = new WebSocket(GOOGLE_LIVE_WS_URL);

    ws.onopen = () => {
      console.log(`[Gemini Live] Socket opened for ${MODEL_NAME}`);
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
        inputAudioTranscription: {}, // Enables real-time transcription of what user says
        outputAudioTranscription: {}, // Enables real-time transcription of AI reply
        systemInstruction: {
          parts: [
            {
              text: `You are Novax, an avant-garde AI companion. You talk with the user naturally in Urdu and Hinglish "Please don't spit hindi text". You have live vision enabled when the user transmits video. Welcome the user briefly. The user appears to be some muslim.`,
            },
          ],
        },
      };

      if (sessionHandle) {
        setupConfig.sessionResumption = { handle: sessionHandle };
        console.log(`[Gemini Live] Attempting session resumption with handle: ${sessionHandle}`);
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

        // 1. Handshake Complete
        if (msg.setupComplete !== undefined) {
          console.log('[Gemini Live] Handshake complete.');
          isSetupComplete = true;

          while (pendingMessages.length > 0) {
            const nextMsg = pendingMessages.shift();
            transmitText(nextMsg);
          }

          if (!hasSentInitialBoot && !sessionHandle) {
            hasSentInitialBoot = true;
            transmitText('Please give me a very brief, friendly welcome in Urdu/Hindi.');
          }
          return;
        }

        // 2. Cache Fresh Session Handle in Background
        if (msg.sessionResumptionUpdate) {
          const update = msg.sessionResumptionUpdate;
          if (update.resumable && update.newHandle) {
            sessionHandle = update.newHandle;
            SessionVault.storeHandle(update.newHandle);
            console.log('[Gemini Live] Cached session resumption handle to localStorage.');
          }
        }

        // 3. Server Multimodal Content
        if (msg.serverContent) {
          const sc = msg.serverContent;

          if (sc.interrupted) {
            audio.stopAll();
            dialogue.purge();
          }

          // Grab the text/transcript returned by Gemini of what the user spoke and what it understood
          const inTranscript = sc.inputTranscription || sc.interimInputTranscription;
          if (inTranscript && inTranscript.text) {
            dialogue.showUser(inTranscript.text);
          }

          // Output transcript of what AI is saying
          const outTranscript = sc.outputTranscription;
          if (outTranscript && outTranscript.text) {
            dialogue.feedAiTranscript(outTranscript.text);
          }

          if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
            for (const part of sc.modelTurn.parts) {
              if (part.inlineData?.data) {
                audio.playChunk(part.inlineData.data);
              }
            }
          }

          if (sc.turnComplete) {
            dialogue.concludeAiTurn();
          }
        }
      } catch (err) {
        console.warn('[Message Warning]:', err);
      }
    };

    ws.onerror = (e) => {
      console.warn('[WebSocket Error]:', e);
    };

    ws.onclose = (event) => {
      isSetupComplete = false;

      if (event.code === 1007 || event.code === 1008 || event.reason?.includes('resumption')) {
        console.warn('[Gemini Live] Session handle invalidated by server. Clearing cache.');
        SessionVault.clear();
        sessionHandle = null;
      }

      if (!isReconnecting) {
        isReconnecting = true;
        setTimeout(connectLiveGateway, 2500);
      }
    };
  } catch (err) {
    console.error('[Connect Error]:', err);
  }
}

connectLiveGateway();

function transmitText(text) {
  if (!text || !text.trim() || !ws || ws.readyState !== WebSocket.OPEN || !isSetupComplete) return;

  dialogue.showUser(text.trim());
  dialogue.beginAiTurn();

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

function queueOrSendText(text) {
  if (!text || !text.trim()) return;
  audio.initOutput();

  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    connectLiveGateway();
  }

  if (ws && ws.readyState === WebSocket.OPEN && isSetupComplete) {
    transmitText(text);
  } else {
    pendingMessages.push(text.trim());
  }
}

function transmitAudioChunk(base64Data) {
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

// =========================================================
// UNIVERSAL KEYBOARD FOCUS (TYPE ANYWHERE ON SCREEN/PC)
// =========================================================
function focusInputInterface() {
  if (omniInput) {
    omniInput.focus();
    omniInput.click();
  }
}

omniInput.addEventListener('input', () => {
  const text = omniInput.value;
  if (text.length > 0) {
    ghostChars.textContent = text;
    ghostTyping.classList.remove('hidden');
  } else {
    ghostTyping.classList.add('hidden');
  }
});

omniInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const val = omniInput.value.trim();
    if (val) {
      queueOrSendText(val);
      omniInput.value = '';
      ghostTyping.classList.add('hidden');
    }
  } else if (e.key === 'Escape') {
    omniInput.value = '';
    ghostTyping.classList.add('hidden');
    if (audio.isSpeaking()) {
      audio.stopAll();
      dialogue.purge();
      if (ws && ws.readyState === WebSocket.OPEN && isSetupComplete) {
        ws.send(JSON.stringify({ clientContent: { turnComplete: true } }));
      }
    }
  }
});

// PC keystrokes immediately captured
window.addEventListener('keydown', (e) => {
  if (e.target !== omniInput && !e.ctrlKey && !e.metaKey && !e.altKey) {
    focusInputInterface();
  }
});

// Tap/click anywhere focuses hidden input
window.addEventListener('click', (e) => {
  if (!e.target.closest('#control-dock') && !e.target.closest('#camera-frame')) {
    focusInputInterface();
  }
});

btnCamera.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleCamera();
});

btnMic.addEventListener('click', (e) => {
  e.stopPropagation();
  if (audio.isListening) {
    audio.stopMicrophone();
    btnMic.classList.remove('active');
  } else {
    audio.startMicrophone(transmitAudioChunk);
    btnMic.classList.add('active');
  }
});

btnResetSession.addEventListener('click', (e) => {
  e.stopPropagation();
  SessionVault.clear();
  sessionHandle = null;
  if (ws) {
    try { ws.close(); } catch {}
  }
  dialogue.purge();
  console.log('[SessionVault] User purged session cache.');
});

// Unlock audio on initial gesture
function unlockMedia() {
  audio.initOutput();
  audio.startMicrophone(transmitAudioChunk);
}
window.addEventListener('click', unlockMedia, { once: true });
window.addEventListener('touchstart', unlockMedia, { once: true });

// Pointer Tracking
window.addEventListener('mousemove', (e) => {
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2 - 25;
  pointerX = Math.max(-1, Math.min(1, (e.clientX - cx) / (window.innerWidth * 0.4)));
  pointerY = Math.max(-1, Math.min(1, (e.clientY - cy) / (window.innerHeight * 0.4)));
});

// Blinking Cycle
let isBlinking = false;
function triggerBlinkCycle() {
  const interval = 2200 + Math.random() * 3400;
  setTimeout(() => {
    isBlinking = true;
    setTimeout(() => {
      isBlinking = false;
      triggerBlinkCycle();
    }, 120);
  }, interval);
}
triggerBlinkCycle();

// =========================================================
// 60FPS GRAPHITE/SLATE ANIMATION LOOP
// =========================================================
let smoothedVol = 0;
let time = 0;

function renderFrame() {
  time += 0.04;

  const speaking = audio.isSpeaking();
  const rawVol = speaking ? audio.getOutputVolume() : 0;
  smoothedVol += (rawVol - smoothedVol) * 0.32;
  const vol = smoothedVol;

  audio.smoothedMicLevel += (audio.userMicLevel - audio.smoothedMicLevel) * 0.35;
  const micLevel = audio.smoothedMicLevel;
  const isHearing = audio.isListening && micLevel > 0.025;

  // 1. Reactive State
  if (monolithStage) {
    monolithStage.classList.toggle('speaking', speaking);

    if (isHearing && !speaking) {
      monolithStage.classList.add('hearing');

      const waveOpacity = Math.min(1, micLevel * 2.8);
      if (lateralWaves) lateralWaves.style.opacity = waveOpacity.toString();

      if (foreheadRipple) {
        foreheadRipple.setAttribute('opacity', (waveOpacity * 0.9).toString());
        foreheadRipple.setAttribute('r', (4 + micLevel * 9).toString());
      }

      if (irisL) irisL.setAttribute('fill', '#ffffff');
      if (irisR) irisR.setAttribute('fill', '#ffffff');

      meterBars.forEach((bar, i) => {
        const h = 4 + Math.sin(time * 12 + i * 1.3) * 7 * micLevel + micLevel * 16;
        bar.style.height = `${Math.max(4, h)}px`;
      });

      if (acousticRing) acousticRing.classList.add('active');
    } else {
      monolithStage.classList.remove('hearing');
      if (lateralWaves) lateralWaves.style.opacity = '0';
      if (foreheadRipple) foreheadRipple.setAttribute('opacity', '0');
      if (acousticRing) acousticRing.classList.remove('active');

      if (!speaking) {
        if (irisL) irisL.setAttribute('fill', '#d8d8e0');
        if (irisR) irisR.setAttribute('fill', '#d8d8e0');
      }
    }
  }

  // 2. Speaking Aperture
  if (speaking && vol > 0.015) {
    const wave = Math.sin(time * 15) * 0.22;
    const mouthHeight = Math.max(4, Math.min(44, 6 + vol * 46 + wave * 5));
    const mouthWidth = Math.max(36, Math.min(74, 44 + vol * 24));

    if (apertureDepth) {
      apertureDepth.setAttribute('rx', (mouthWidth / 2).toString());
      apertureDepth.setAttribute('ry', (mouthHeight / 2).toString());
      apertureDepth.setAttribute('opacity', '1');
    }

    if (apertureLum) {
      apertureLum.setAttribute('rx', (mouthWidth / 2.8).toString());
      apertureLum.setAttribute('ry', (mouthHeight / 2.8).toString());
      apertureLum.setAttribute('opacity', '0.6');
    }

    if (apertureSlit) {
      apertureSlit.setAttribute(
        'd',
        `M -${mouthWidth / 2} 0 Q 0 ${mouthHeight / 2 + 2.5} ${mouthWidth / 2} 0`
      );
    }

    if (vocalSpectrogram) vocalSpectrogram.classList.add('speaking');
    vocalBars.forEach((bar, i) => {
      const barH = 5 + Math.sin(time * 11 + i * 0.9) * 12 * vol + vol * 18;
      bar.style.height = `${Math.max(4, barH)}px`;
    });

    const swayX = Math.sin(time * 3) * 2 * vol;
    const swayY = Math.cos(time * 4) * 2.4 * vol;
    if (monolithSvg) monolithSvg.style.transform = `translate(${swayX}px, ${swayY}px)`;
  } else {
    if (apertureDepth) apertureDepth.setAttribute('opacity', '0');
    if (apertureLum) apertureLum.setAttribute('opacity', '0');
    if (apertureSlit) apertureSlit.setAttribute('d', 'M -22 0 Q 0 1.5 22 0');
    if (vocalSpectrogram) vocalSpectrogram.classList.remove('speaking');

    const breatheX = Math.sin(time * 0.8) * 1.1;
    const breatheY = Math.cos(time * 0.6) * 1.6;
    if (monolithSvg) monolithSvg.style.transform = `translate(${breatheX}px, ${breatheY}px)`;
  }

  // 3. Eye Tracking & Blinking
  const lookX = (pointerX * 3.5).toFixed(2);
  const lookY = (pointerY * 2.6).toFixed(2);
  if (irisL && irisR && pupilL && pupilR) {
    irisL.setAttribute('cx', lookX);
    irisL.setAttribute('cy', lookY);
    irisR.setAttribute('cx', lookX);
    irisR.setAttribute('cy', lookY);
    pupilL.setAttribute('cx', (pointerX * 4.4).toFixed(2));
    pupilL.setAttribute('cy', (pointerY * 3.2).toFixed(2));
    pupilR.setAttribute('cx', (pointerX * 4.4).toFixed(2));
    pupilR.setAttribute('cy', (pointerY * 3.2).toFixed(2));
  }

  if (opticalL && opticalR) {
    if (isBlinking) {
      opticalL.setAttribute('transform', 'translate(96, 100) scale(1, 0.08)');
      opticalR.setAttribute('transform', 'translate(164, 100) scale(1, 0.08)');
    } else {
      opticalL.setAttribute('transform', 'translate(96, 98) scale(1, 1)');
      opticalR.setAttribute('transform', 'translate(164, 98) scale(1, 1)');
    }
  }

  // 4. Ambient Fog Scale
  if (ambientFog) {
    const fogScale = 1 + (speaking ? vol * 0.42 : isHearing ? micLevel * 0.32 : 0.04);
    ambientFog.style.transform = `scale(${fogScale})`;
  }

  requestAnimationFrame(renderFrame);
}

requestAnimationFrame(renderFrame);
