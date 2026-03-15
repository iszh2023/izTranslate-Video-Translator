/* global chrome */

(() => {
  if (window.top !== window) return; // only top frame
  if (window.__izTranslateInjected || window.__iTranslateInjected) return;
  // Keep the old key set too so upgrades don't temporarily allow double-injection on already-open tabs.
  window.__izTranslateInjected = true;
  window.__iTranslateInjected = true;

  const DEFAULTS = {
    enabledGlobal: true,
    speak: false,
    reading: false, // only capture/speak captions when true (user gesture friendly)
    muteVideo: false, // legacy
    audioMix: 1.0, // 0=original only, 1=TTS only
    syncSpeech: true,
    slowVideo: false,
    baseSpeechRate: 1.0,
    targetLang: "auto",
    mode: "captions",
    captionSource: "auto", // auto | dom | track
    donateEnabled: true,
    donateIntervalMin: 10,
    donateLastAt: 0,
    donateFirstShown: false,
    sidebarWidth: 380,
  };

  const state = {
    settings: { ...DEFAULTS },
    mounted: false,
    open: true,
    logMax: 200,
    currentVideo: null,
    currentTrack: null,
    lastCueKey: "",
    lastHandledKey: "",
    translateCache: new Map(),
    speaking: false,
    ui: {},
    lastDomCaption: "",
    lastDomAt: 0,
    videoMuteSnapshot: null,
    videoRateSnapshot: null,
    recentCaptionAt: new Map(),
    ttsNextId: 1,
    ttsActive: new Set(),
    ttsOutstanding: new Set(),
    ttsTimeouts: new Map(),
    ttsEstEndAt: 0,
    proactivePauseTimer: 0,
    lagPauseTimer: 0,
    lagPulseTimer: 0,
    lastLagPauseAt: 0,
    pausedByExt: false,
    wasPausedBeforeExt: false,
    lagPaused: false,
    langDetectCache: new Map(),
    domPending: null,
    domPaceSec: 2.2,
    domLastCommitAt: 0,
    lastTrackSig: "",
    speakQueue: [],
    drainingQueue: false,
    lastSpokenNorm: "",
    lastSpokenAt: 0,
    lastSpokenFullNorm: "",
    lastSpokenFullAt: 0,
    lastCaptionFullNorm: "",
    lastCaptionFullAt: 0,
    recentCaptionTextAt: new Map(),
    sidebar: { resizing: false, resizeRaf: 0 },
  };

  const LAG_PAUSE_GRACE_MS = 220;
  const LAG_PULSE_MIN_MS = 500;
  const LAG_PULSE_MAX_MS = 2200;
  const LAG_COOLDOWN_MIN_MS = 1800;
  const LAG_COOLDOWN_MAX_MS = 9000;
  const DOM_STABLE_MS = 450;
  const DOM_MAX_WAIT_MS = 1600;

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function safeText(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function normalizeCaptionKey(text) {
    let t = String(text || "");
    try {
      t = t.normalize("NFKC");
    } catch {
      // ignore
    }
    // Remove zero-width and directionality marks that can make strings look identical but compare different.
    t = t.replace(/[\u200B-\u200F\uFEFF\u2060\u202A-\u202E]/g, "");
    t = t.replace(/\u00A0/g, " ");
    return safeText(t);
  }

  function softNormalizeForDedupe(text) {
    // Make "same line" detection more robust across minor punctuation/spacing changes.
    // This is intentionally lossy: it is only used to prevent obvious repeats.
    return normalizeCaptionKey(text)
      .toLowerCase()
      .replace(/[\s.,!?;:，。！？；：、\-–—"“”'‘’()\[\]{}]+/g, " ")
      .trim();
  }

  function quantTime(x, step = 0.1) {
    const v = Number(x);
    if (!Number.isFinite(v)) return 0;
    return Math.round(v / step) * step;
  }

  function getNow() {
    const d = new Date();
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  async function loadSettings() {
    const got = await chrome.storage.sync.get(DEFAULTS);
    const merged = { ...DEFAULTS, ...got };
    // Migrate legacy muteVideo -> audioMix without accidentally silencing speech.
    if (got.audioMix == null && got.muteVideo === true) merged.audioMix = 1.0;
    merged.audioMix = clamp(Number(merged.audioMix) || 0, 0, 1);
    merged.baseSpeechRate = clamp(Number(merged.baseSpeechRate) || DEFAULTS.baseSpeechRate, 0.4, 3.5);
    merged.sidebarWidth = clamp(Number(merged.sidebarWidth) || DEFAULTS.sidebarWidth, 180, Math.floor(window.innerWidth * 0.85));
    state.settings = merged;
  }

  function resetCaptionPipelineForLanguageChange() {
    // When switching voice language mid-playback, queued suffixes from the previous
    // stream can cause audible repeats. Reset everything so we restart cleanly.
    stopSpeaking();
    state.lastCueKey = "";
    state.lastHandledKey = "";
    state.lastCaptionFullNorm = "";
    state.lastCaptionFullAt = 0;
    state.lastSpokenNorm = "";
    state.lastSpokenAt = 0;
    state.lastSpokenFullNorm = "";
    state.lastSpokenFullAt = 0;
    state.recentCaptionAt.clear();
    state.recentCaptionTextAt.clear();
    // Prevent a burst of DOM "rebuild" commits from being treated as a new stream.
    state.domLastCommitAt = 0;
    state.domPaceSec = 2.2;
  }

  function injectUI() {
    if (state.mounted) return;
    state.mounted = true;

    const host = document.createElement("div");
    host.id = "vt-sidebar-host";
    host.style.all = "initial";
    host.style.position = "fixed";
    host.style.top = "0";
    host.style.right = "0";
    host.style.height = "100vh";
    host.style.width = `${state.settings.sidebarWidth || 380}px`;
    host.style.zIndex = "2147483647";
    host.style.pointerEvents = "auto";
    host.style.overflow = "visible";
    host.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    host.style.color = "#eef2ff";
    host.style.display = "block";

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .wrap {
        height: 100vh;
        width: 100%;
        display: flex;
        flex-direction: column;
        background: rgba(10, 16, 28, 0.92);
        backdrop-filter: blur(10px);
        border-left: 1px solid rgba(255,255,255,0.14);
        position: relative;
      }
      .resizer {
        position: absolute;
        top: 0;
        left: -6px;
        width: 16px;
        height: 100%;
        cursor: ew-resize;
        z-index: 10;
      }
      .resizer::after {
        content: "";
        position: absolute;
        top: 0;
        left: 7px;
        width: 3px;
        height: 100%;
        background: rgba(255,255,255,0.10);
      }
      .resizer:hover::after {
        background: rgba(93, 214, 192, 0.70);
      }
      .hdr {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 10px 8px;
        border-bottom: 1px solid rgba(255,255,255,0.10);
      }
      .title {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .title strong { font-size: 13px; color: rgba(255,255,255,0.95); }
      .title span { font-size: 11px; color: rgba(255,255,255,0.7); }
      .btns { display: flex; gap: 6px; }
      button {
        appearance: none;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(255,255,255,0.06);
        color: rgba(255,255,255,0.92);
        border-radius: 10px;
        padding: 7px 9px;
        cursor: pointer;
        font-size: 12px;
      }
      button.primary {
        background: rgba(93, 214, 192, 0.9);
        color: #071016;
        border-color: rgba(93, 214, 192, 0.9);
        font-weight: 700;
      }
      button:disabled { opacity: 0.5; cursor: not-allowed; }
      .controls {
        padding: 10px;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        border-bottom: 1px solid rgba(255,255,255,0.10);
      }
      .controls label { font-size: 11px; color: rgba(255,255,255,0.72); display:block; margin: 0 0 4px; }
      select, input[type="text"]{
        width: 100%;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(0,0,0,0.22);
        color: rgba(255,255,255,0.92);
        padding: 7px 9px;
        font-size: 12px;
        outline: none;
      }
      .tog {
        grid-column: 1 / -1;
        display:flex;
        align-items:center;
        justify-content: space-between;
        gap: 10px;
        padding: 8px 10px;
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 10px;
        background: rgba(0,0,0,0.18);
      }
      .tog .meta { display:flex; flex-direction: column; gap: 2px; }
      .tog .meta strong { font-size: 12px; }
      .tog .meta span { font-size: 11px; color: rgba(255,255,255,0.72); }
      .log {
        padding: 10px;
        overflow: auto;
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .bubble {
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 14px;
        padding: 8px 10px;
        background: rgba(255,255,255,0.06);
      }
      .bubble.me { border-color: rgba(93, 214, 192, 0.35); background: rgba(93, 214, 192, 0.10); }
      .bubble .meta { display:flex; justify-content: space-between; gap: 8px; font-size: 10px; color: rgba(255,255,255,0.62); margin-bottom: 4px; }
      .bubble .txt { font-size: 12.5px; color: rgba(255,255,255,0.95); white-space: pre-wrap; word-break: break-word; }
      .composer {
        padding: 10px;
        border-top: 1px solid rgba(255,255,255,0.10);
        display: flex;
        gap: 8px;
      }
      .composer input { flex: 1; }
      .donatePage {
        padding: 12px;
        overflow: auto;
        flex: 1;
        display: none;
      }
      .donatePage h2 {
        margin: 0 0 8px;
        font-size: 14px;
        color: rgba(255,255,255,0.95);
      }
      .donatePage p, .donatePage li {
        color: rgba(255,255,255,0.78);
        font-size: 12px;
        line-height: 1.45;
      }
      .modal {
        position: absolute;
        inset: 0;
        background: rgba(0,0,0,0.45);
        display: none;
        align-items: center;
        justify-content: center;
        padding: 14px;
      }
      .modal .box {
        width: 100%;
        max-width: 340px;
        border-radius: 16px;
        border: 1px solid rgba(255,255,255,0.16);
        background: rgba(12, 18, 32, 0.96);
        padding: 12px;
        box-shadow: 0 10px 28px rgba(0,0,0,0.35);
      }
      .modal .box strong { display:block; margin-bottom: 6px; }
      .modal .box .row { display:flex; gap: 8px; margin-top: 10px; }
      .modal .box .row button { flex: 1; }
    `;

    const wrap = document.createElement("div");
    wrap.className = "wrap";
    wrap.innerHTML = `
      <div id="vt-resizer" class="resizer" title="Drag to resize"></div>
      <div class="hdr">
        <div class="title">
          <strong>Video Translator</strong>
          <span id="vt-status">Looking for captions…</span>
        </div>
        <div class="btns">
          <button id="vt-read" class="primary" title="Read/Stop">Read</button>
          <button id="vt-stop" title="Stop">Stop</button>
          <button id="vt-clear" title="Clear">Clear</button>
        </div>
      </div>
      <div class="controls">
        <div>
          <label>Voice language</label>
          <select id="vt-lang"></select>
        </div>
        <div>
          <label>Captions source</label>
          <select id="vt-track"></select>
        </div>
        <div class="tog">
          <div class="meta">
            <strong>Speak out loud</strong>
            <span>Reads captions using TTS</span>
          </div>
          <input id="vt-speak" type="checkbox" />
        </div>
        <div class="tog">
          <div class="meta">
            <strong>Read captions</strong>
            <span>Capture captions into the sidebar</span>
          </div>
          <input id="vt-reading" type="checkbox" />
        </div>
        <div class="tog">
          <div class="meta">
            <strong>Audio mix</strong>
            <span>Original ↔ Spoken</span>
          </div>
          <input id="vt-mix" type="range" min="0" max="1" step="0.01" />
        </div>
        <div class="tog">
          <div class="meta">
            <strong>Try sync</strong>
            <span>Adjust speech rate (best with tracks)</span>
          </div>
          <input id="vt-sync" type="checkbox" />
        </div>
        <div class="tog">
          <div class="meta">
            <strong>Auto pause when behind</strong>
            <span>Pauses briefly only if speech lags</span>
          </div>
          <input id="vt-slow" type="checkbox" />
        </div>
        <div style="grid-column: 1 / -1;">
          <label>Speech speed</label>
          <input id="vt-speed" type="range" min="0.4" max="3.5" step="0.05" />
          <div style="margin-top:6px; display:flex; justify-content: space-between; color: rgba(255,255,255,0.62); font-size: 11px;">
            <span>Very slow</span>
            <span>Very fast</span>
          </div>
          <div style="margin-top:6px; color: rgba(255,255,255,0.62); font-size: 11px;">
            Selected: <span id="vt-speed-val">1.00×</span>
          </div>
        </div>
      </div>
      <div id="vt-donate-page" class="donatePage">
        <div style="display:flex; align-items:center; justify-content: space-between; gap: 8px;">
          <button id="vt-donate-close" title="Close">✕</button>
          <h2 style="margin:0; flex:1; text-align:center;">Support our nonprofit</h2>
          <div style="width:42px;"></div>
        </div>
        <p style="margin-top:10px;">Please donate and support our nonprofit organization.</p>
        <label style="display:block; margin: 10px 0 6px; color: rgba(255,255,255,0.72); font-size: 11px;">Donation amount (USD)</label>
        <input id="vt-donate-amount" type="text" placeholder="10" style="width:100%; border-radius: 10px; border: 1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.22); color: rgba(255,255,255,0.92); padding: 8px 10px; outline:none; font-size: 12px;" />
        <div style="height: 10px;"></div>
        <button id="vt-donate-submit" class="primary">Donate</button>
        <div style="margin-top:8px; color: rgba(255,255,255,0.62); font-size: 11px;">Donations aren’t enabled yet. (This button does nothing for now.)</div>
      </div>
      <div id="vt-log" class="log"></div>
      <div class="composer">
        <input id="vt-manual" type="text" placeholder="Type text to speak…" />
        <button id="vt-send" class="primary">Send</button>
      </div>
      <div id="vt-donate" class="modal" aria-hidden="true">
        <div class="box">
          <strong>Please donate</strong>
          <div style="color: rgba(255,255,255,0.78); font-size: 12px; line-height: 1.45;">
            Support our nonprofit organization so we can keep improving captions + sync.
          </div>
          <div class="row">
            <button id="vt-donate-yes" class="primary">Donate</button>
            <button id="vt-donate-no">Maybe later</button>
          </div>
        </div>
      </div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(wrap);
    document.documentElement.appendChild(host);

    state.ui.host = host;
    state.ui.shadow = shadow;
    state.ui.wrap = wrap;
    state.ui.status = shadow.getElementById("vt-status");
    state.ui.log = shadow.getElementById("vt-log");
    state.ui.donatePage = shadow.getElementById("vt-donate-page");
    state.ui.btnDonateClose = shadow.getElementById("vt-donate-close");
    state.ui.donateAmount = shadow.getElementById("vt-donate-amount");
    state.ui.btnDonateSubmit = shadow.getElementById("vt-donate-submit");
    state.ui.donateModal = shadow.getElementById("vt-donate");
    state.ui.btnDonateYes = shadow.getElementById("vt-donate-yes");
    state.ui.btnDonateNo = shadow.getElementById("vt-donate-no");
    state.ui.lang = shadow.getElementById("vt-lang");
    state.ui.track = shadow.getElementById("vt-track");
    state.ui.speak = shadow.getElementById("vt-speak");
    state.ui.reading = shadow.getElementById("vt-reading");
    state.ui.mix = shadow.getElementById("vt-mix");
    state.ui.sync = shadow.getElementById("vt-sync");
    state.ui.slow = shadow.getElementById("vt-slow");
    state.ui.speed = shadow.getElementById("vt-speed");
    state.ui.speedVal = shadow.getElementById("vt-speed-val");
    state.ui.manual = shadow.getElementById("vt-manual");
    state.ui.send = shadow.getElementById("vt-send");
    state.ui.btnClear = shadow.getElementById("vt-clear");
    state.ui.btnRead = shadow.getElementById("vt-read");
    state.ui.btnStop = shadow.getElementById("vt-stop");
    state.ui.resizer = shadow.getElementById("vt-resizer");

    fillLangSelect();
    state.ui.lang.value = state.settings.targetLang;
    state.ui.speak.checked = !!state.settings.speak;
    state.ui.reading.checked = !!state.settings.reading;
    state.ui.mix.value = String(state.settings.audioMix ?? DEFAULTS.audioMix);
    state.ui.sync.checked = state.settings.syncSpeech !== false;
    state.ui.slow.checked = !!state.settings.slowVideo;
    {
      const v = Number(state.settings.baseSpeechRate ?? DEFAULTS.baseSpeechRate);
      state.ui.speed.value = String(Number.isFinite(v) ? v : DEFAULTS.baseSpeechRate);
      if (state.ui.speedVal) state.ui.speedVal.textContent = `${Number(state.ui.speed.value).toFixed(2)}×`;
    }

    state.ui.lang.addEventListener("change", async () => {
      const prev = String(state.settings.targetLang || "auto");
      state.settings.targetLang = state.ui.lang.value;
      await chrome.storage.sync.set({ targetLang: state.settings.targetLang });
      state.translateCache.clear();
      if (String(state.settings.targetLang || "auto") !== prev) resetCaptionPipelineForLanguageChange();
      setStatus("Target language updated.");
    });

    state.ui.speak.addEventListener("change", async () => {
      state.settings.speak = state.ui.speak.checked;
      await chrome.storage.sync.set({ speak: state.settings.speak });
    });

    state.ui.reading.addEventListener("change", async () => {
      state.settings.reading = state.ui.reading.checked;
      await chrome.storage.sync.set({ reading: state.settings.reading });
      setStatus(state.settings.reading ? "Reading captions…" : "Paused. Press Read to start.");
      state.lastCueKey = "";
      state.lastHandledKey = "";
      if (!state.settings.reading) {
        stopSpeaking();
        applyPlaybackRate(null, { restore: true });
        restoreAudio();
        state.ttsActive.clear();
        state.recentCaptionAt.clear();
        state.recentCaptionTextAt.clear();
        state.lastSpokenNorm = "";
        state.lastSpokenAt = 0;
        state.lastSpokenFullNorm = "";
        state.lastSpokenFullAt = 0;
        applyPauseWhileSpeaking();
      }
    });

    state.ui.mix.addEventListener("input", async () => {
      state.settings.audioMix = clamp(Number(state.ui.mix.value) || 0, 0, 1);
      await chrome.storage.sync.set({ audioMix: state.settings.audioMix });
      applyAudioMix();
    });

    state.ui.sync.addEventListener("change", async () => {
      state.settings.syncSpeech = state.ui.sync.checked;
      await chrome.storage.sync.set({ syncSpeech: state.settings.syncSpeech });
    });

    state.ui.slow.addEventListener("change", async () => {
      state.settings.slowVideo = state.ui.slow.checked;
      await chrome.storage.sync.set({ slowVideo: state.settings.slowVideo });
      applyPlaybackRate(null);
    });

    state.ui.speed.addEventListener("input", async () => {
      state.settings.baseSpeechRate = Number(state.ui.speed.value) || DEFAULTS.baseSpeechRate;
      await chrome.storage.sync.set({ baseSpeechRate: state.settings.baseSpeechRate });
      if (state.ui.speedVal) state.ui.speedVal.textContent = `${Number(state.settings.baseSpeechRate).toFixed(2)}×`;
      // If we're queueing speech (slowVideo mode), changing speed won't affect already-enqueued utterances.
      // Stop the current queue so the next caption uses the new speed immediately.
      if (state.settings.reading && state.settings.speak && state.settings.slowVideo && state.ttsOutstanding.size > 0) {
        stopSpeaking();
        setStatus("Speed updated.");
      }
    });

    state.ui.btnRead.addEventListener("click", async () => {
      state.settings.reading = true;
      state.settings.speak = true;
      state.ui.reading.checked = true;
      state.ui.speak.checked = true;
      await chrome.storage.sync.set({ reading: true, speak: true });
      setStatus("Reading captions…");
      state.lastCueKey = "";
      state.lastHandledKey = "";
      state.recentCaptionAt.clear();
      state.recentCaptionTextAt.clear();
      state.lastSpokenNorm = "";
      state.lastSpokenAt = 0;
      state.lastSpokenFullNorm = "";
      state.lastSpokenFullAt = 0;
      applyPlaybackRate(null, { restore: true });
      applyAudioMix();
    });

    state.ui.btnStop.addEventListener("click", async () => {
      stopSpeaking();
      applyPlaybackRate(null, { restore: true });
      restoreAudio();
      state.ttsActive.clear();
      applyPauseWhileSpeaking();
      state.settings.reading = false;
      state.settings.speak = false;
      state.ui.reading.checked = false;
      state.ui.speak.checked = false;
      await chrome.storage.sync.set({ reading: false, speak: false });
      state.lastCueKey = "";
      state.lastHandledKey = "";
      state.recentCaptionAt.clear();
      state.recentCaptionTextAt.clear();
      state.lastSpokenNorm = "";
      state.lastSpokenAt = 0;
      state.lastSpokenFullNorm = "";
      state.lastSpokenFullAt = 0;
      setStatus("Stopped.");
    });

    state.ui.btnClear.addEventListener("click", () => {
      state.ui.log.textContent = "";
      state.lastCueKey = "";
      state.lastHandledKey = "";
    });

    state.ui.resizer.addEventListener("mousedown", (e) => startResize(e));
    state.ui.btnDonateClose.addEventListener("click", () => setView("video"));
    state.ui.btnDonateYes.addEventListener("click", () => {
      hideDonatePrompt();
      chrome.runtime.sendMessage({ type: "VT_OPEN_URL", url: "https://www.google.com/" }).catch(() => {});
      setView("video");
    });
    state.ui.btnDonateNo.addEventListener("click", () => {
      hideDonatePrompt();
    });
    state.ui.btnDonateSubmit.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "VT_OPEN_URL", url: "https://www.google.com/" }).catch(() => {});
      setStatus("Opening donation page…");
      setView("video");
    });

    attachResizerExtras();

    state.ui.track.addEventListener("change", () => {
      const id = state.ui.track.value;
      if (!id) return;
      if (id === "auto" || id === "dom") {
        state.settings.captionSource = id;
        chrome.storage.sync.set({ captionSource: id }).catch(() => {});
        state.lastCueKey = "";
        if (id === "dom") setCurrentTrack(null);
        setStatus(id === "dom" ? "Using on-screen captions (DOM)." : "Auto captions source.");
        return;
      }
      const t = (state.currentVideo?.textTracks && state.currentVideo.textTracks[Number(id)]) || null;
      state.settings.captionSource = "track";
      chrome.storage.sync.set({ captionSource: "track" }).catch(() => {});
      setCurrentTrack(t);
    });

    state.ui.send.addEventListener("click", () => {
      const txt = safeText(state.ui.manual.value);
      if (!txt) return;
      state.ui.manual.value = "";
      handleCaption(txt, { source: "Manual" }).catch(() => {});
    });

    state.ui.manual.addEventListener("keydown", (e) => {
      if (e.key === "Enter") state.ui.send.click();
    });

    toggleOpen(true);
  }

  function setView(view) {
    const isDonate = view === "donate";
    if (state.ui.donatePage) state.ui.donatePage.style.display = isDonate ? "block" : "none";
    if (state.ui.log) state.ui.log.style.display = isDonate ? "none" : "flex";
    const composer = state.ui.shadow?.querySelector(".composer");
    if (composer) composer.style.display = isDonate ? "none" : "flex";
    const controls = state.ui.shadow?.querySelector(".controls");
    if (controls) controls.style.display = isDonate ? "none" : "grid";
    state.open = true;
    if (state.ui.host) state.ui.host.style.display = "block";
  }

  function hideDonatePrompt() {
    if (!state.ui.donateModal) return;
    state.ui.donateModal.style.display = "none";
    state.ui.donateModal.setAttribute("aria-hidden", "true");
  }

  async function maybeShowDonatePrompt(force = false) {
    if (!state.mounted || !state.open) return;
    if (!state.settings.donateEnabled) return;
    // Don't nag while on the donate page itself.
    if (state.ui.donatePage && state.ui.donatePage.style.display !== "none") return;
    if (!state.ui.donateModal) return;

    const now = Date.now();
    const intervalMs = Math.max(1, Number(state.settings.donateIntervalMin) || 10) * 60_000;
    const lastAt = Number(state.settings.donateLastAt) || 0;
    const firstShown = !!state.settings.donateFirstShown;

    const should = force ? !firstShown : now - lastAt >= intervalMs;
    if (!should) return;

    state.settings.donateLastAt = now;
    state.settings.donateFirstShown = true;
    chrome.storage.sync.set({ donateLastAt: now, donateFirstShown: true }).catch(() => {});

    state.ui.donateModal.style.display = "flex";
    state.ui.donateModal.setAttribute("aria-hidden", "false");
  }

  function fillLangSelect() {
    const langs = [
      ["auto", "Auto (detect from captions)"],
      ["en", "English"],
      ["es", "Spanish"],
      ["fr", "French"],
      ["de", "German"],
      ["it", "Italian"],
      ["pt", "Portuguese"],
      ["ru", "Russian"],
      ["uk", "Ukrainian"],
      ["tr", "Turkish"],
      ["ar", "Arabic"],
      ["hi", "Hindi"],
      ["zh", "Chinese"],
      ["ja", "Japanese"],
      ["ko", "Korean"],
      ["vi", "Vietnamese"],
      ["id", "Indonesian"],
    ];
    state.ui.lang.textContent = "";
    for (const [code, name] of langs) {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = code === "auto" ? name : `${name} (${code})`;
      state.ui.lang.appendChild(opt);
    }
  }

  function setStatus(text) {
    if (!state.ui.status) return;
    state.ui.status.textContent = text;
  }

  function startResize(e) {
    if (!state.ui.host) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    state.sidebar.resizing = true;

    const onMove = (ev) => {
      if (!state.sidebar.resizing) return;
      const maxW = Math.floor(window.innerWidth * 0.85);
      const minW = 180;
      const newW = clamp(window.innerWidth - ev.clientX, minW, maxW);
      if (state.sidebar.resizeRaf) return;
      state.sidebar.resizeRaf = requestAnimationFrame(() => {
        state.sidebar.resizeRaf = 0;
        state.ui.host.style.width = `${Math.round(newW)}px`;
      });
    };

    const onUp = () => {
      if (!state.sidebar.resizing) return;
      state.sidebar.resizing = false;
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      const w = parseInt(String(state.ui.host.style.width || state.settings.sidebarWidth || 380), 10);
      const clamped = clamp(Number(w) || (state.settings.sidebarWidth || 380), 180, Math.floor(window.innerWidth * 0.85));
      state.settings.sidebarWidth = clamped;
      chrome.storage.sync.set({ sidebarWidth: clamped }).catch(() => {});
    };

    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
  }

  // Double click the divider to reset width.
  function attachResizerExtras() {
    if (!state.ui.resizer || !state.ui.host) return;
    state.ui.resizer.addEventListener("dblclick", () => {
      const target = clamp(DEFAULTS.sidebarWidth, 180, Math.floor(window.innerWidth * 0.85));
      state.settings.sidebarWidth = target;
      state.ui.host.style.width = `${target}px`;
      chrome.storage.sync.set({ sidebarWidth: target }).catch(() => {});
    });
  }

  function toggleOpen(forceOpen) {
    state.open = forceOpen ?? !state.open;
    if (!state.ui.host) return;
    state.ui.host.style.display = state.open ? "block" : "none";
  }

  function pickBestVideo() {
    const vids = Array.from(document.querySelectorAll("video"));
    if (!vids.length) return null;

    let best = null;
    let bestScore = -1;
    for (const v of vids) {
      const r = v.getBoundingClientRect();
      if (r.width < 160 || r.height < 90) continue;
      const area = r.width * r.height;
      const inView = r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
      if (!inView) continue;
      let score = area;
      if (!v.paused) score *= 1.4;
      if (document.activeElement === v) score *= 1.2;
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best || vids[0] || null;
  }

  function listTracks(video) {
    if (!video || !video.textTracks) return [];
    const tracks = [];
    // textTracks is not a real array in some browsers
    for (let i = 0; i < video.textTracks.length; i += 1) {
      const t = video.textTracks[i];
      tracks.push({
        idx: i,
        label: t.label || t.language || `Track ${i + 1}`,
        language: t.language || "",
        kind: t.kind || "",
      });
    }
    return tracks;
  }

  function tracksSignature(tracks) {
    try {
      return (tracks || []).map((t) => `${t.idx}:${t.label}:${t.language}`).join("|");
    } catch {
      return "";
    }
  }

  function refreshTrackSelect() {
    if (!state.ui.track) return;
    // If the user is interacting with the dropdown, do not rebuild (it will close / feel "stuck").
    try {
      if (state.ui.shadow?.activeElement === state.ui.track) return;
    } catch {
      // ignore
    }
    const tracks = listTracks(state.currentVideo);
    const sig = tracksSignature(tracks);
    const needsBuild = state.ui.track.options.length < 2 || sig !== state.lastTrackSig;
    if (needsBuild) {
      state.lastTrackSig = sig;
      state.ui.track.textContent = "";
      const optAuto = document.createElement("option");
      optAuto.value = "auto";
      optAuto.textContent = "Auto (track if available, else on-screen)";
      state.ui.track.appendChild(optAuto);

      const optDom = document.createElement("option");
      optDom.value = "dom";
      optDom.textContent = "On-screen captions (DOM / YouTube)";
      state.ui.track.appendChild(optDom);

      if (tracks.length) {
        const sep = document.createElement("option");
        sep.value = "";
        sep.textContent = "— Tracks —";
        sep.disabled = true;
        state.ui.track.appendChild(sep);
      }

      for (const tr of tracks) {
        const opt = document.createElement("option");
        opt.value = String(tr.idx);
        opt.textContent = `${tr.label}${tr.language ? ` (${tr.language})` : ""}`;
        state.ui.track.appendChild(opt);
      }
    }

    const preferred = state.settings.captionSource || "auto";
    if (preferred === "dom" || preferred === "auto") {
      state.ui.track.value = preferred;
      return;
    }
    if (preferred === "track" && state.currentTrack) {
      for (let i = 0; i < state.currentVideo.textTracks.length; i += 1) {
        if (state.currentVideo.textTracks[i] === state.currentTrack) {
          state.ui.track.value = String(i);
          return;
        }
      }
    }
    state.ui.track.value = "auto";
  }

  function setCurrentTrack(track) {
    state.currentTrack = track || null;
    state.lastCueKey = "";
    if (!state.currentTrack) return;
    try {
      // Only force hidden if disabled; don't hide captions the user turned on.
      if (state.currentTrack.mode === "disabled") state.currentTrack.mode = "hidden";
    } catch {
      // ignore
    }
  }

  function selectBestCaptionTrack(video) {
    if (!video || !video.textTracks) return null;
    const preferredKinds = new Set(["subtitles", "captions"]);
    let best = null;
    for (let i = 0; i < video.textTracks.length; i += 1) {
      const t = video.textTracks[i];
      if (!t) continue;
      const kind = String(t.kind || "").toLowerCase();
      if (preferredKinds.has(kind)) {
        best = t;
        break;
      }
    }
    return best || (video.textTracks.length ? video.textTracks[0] : null);
  }

  function ensureTrackSelected() {
    const v = state.currentVideo;
    if (!v || !v.textTracks) {
      state.currentTrack = null;
      return;
    }
    // If our currentTrack is no longer part of this video, clear it.
    if (state.currentTrack) {
      let found = false;
      for (let i = 0; i < v.textTracks.length; i += 1) {
        if (v.textTracks[i] === state.currentTrack) {
          found = true;
          break;
        }
      }
      if (!found) state.currentTrack = null;
    }
    if (state.settings.captionSource === "dom") return;
    if (state.settings.captionSource !== "track" && state.settings.captionSource !== "auto") return;
    if (state.currentTrack) return;
    if (v.textTracks.length > 0) {
      try {
        setCurrentTrack(selectBestCaptionTrack(v));
      } catch {
        // ignore
      }
    }
  }

  function pickCueFromCues(track, timeSec) {
    if (!track) return null;
    let cues = null;
    try {
      cues = track.cues || null;
    } catch {
      cues = null;
    }
    if (!cues || !cues.length) return null;
    const t = Number(timeSec);
    if (!Number.isFinite(t)) return null;

    // Binary search: last cue with startTime <= t.
    let lo = 0;
    let hi = cues.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const st = Number(cues[mid]?.startTime);
      if (Number.isFinite(st) && st <= t) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (ans < 0) return null;
    const c0 = cues[ans];
    const e0 = Number(c0?.endTime);
    if (Number.isFinite(e0) && t <= e0) return c0;

    const c1 = cues[ans + 1];
    if (c1) {
      const s1 = Number(c1?.startTime);
      const e1 = Number(c1?.endTime);
      if (Number.isFinite(s1) && Number.isFinite(e1) && t >= s1 && t <= e1) return c1;
    }
    return null;
  }

  function findTrackWithActiveCue(video) {
    if (!video || !video.textTracks) return null;
    for (let i = 0; i < video.textTracks.length; i += 1) {
      const t = video.textTracks[i];
      if (!t) continue;
      const kind = String(t.kind || "").toLowerCase();
      if (kind && kind !== "subtitles" && kind !== "captions") continue;
      try {
        if (t.mode === "disabled") t.mode = "hidden";
      } catch {
        // ignore
      }
      try {
        if (t.activeCues && t.activeCues.length) return t;
      } catch {
        // ignore
      }
    }
    return null;
  }

  function appendBubble(kind, title, text) {
    if (!state.ui.log) return;
    const bubble = document.createElement("div");
    bubble.className = `bubble ${kind === "me" ? "me" : ""}`;
    bubble.innerHTML = `
      <div class="meta">
        <span>${title}</span>
        <span>${getNow()}</span>
      </div>
      <div class="txt"></div>
    `;
    bubble.querySelector(".txt").textContent = text;
    state.ui.log.appendChild(bubble);
    // keep small
    while (state.ui.log.childNodes.length > state.logMax) {
      state.ui.log.removeChild(state.ui.log.firstChild);
    }
    state.ui.log.scrollTop = state.ui.log.scrollHeight;
  }

  async function translateText(text) {
    void state;
    return text; // no external translation APIs; captions may already be translated by the site
  }

  function detectLanguage(text) {
    return new Promise((resolve) => {
      try {
        chrome.i18n.detectLanguage(text, (res) => resolve(res));
      } catch {
        resolve(null);
      }
    });
  }

  async function autoDetectYouTubeLang(text) {
    const cleaned = normalizeCaptionKey(text);
    if (!cleaned) return null;
    const key = cleaned.slice(0, 220);
    const cached = state.langDetectCache.get(key);
    if (cached !== undefined) return cached || null;

    const res = await detectLanguage(cleaned);
    const langs = res?.languages || [];
    const best = langs
      .filter((l) => l && l.language && l.language !== "und")
      .sort((a, b) => Number(b.percentage || 0) - Number(a.percentage || 0))[0];
    const lang = best && Number(best.percentage || 0) >= 65 ? String(best.language) : null;
    state.langDetectCache.set(key, lang || "");
    if (state.langDetectCache.size > 250) {
      const it = state.langDetectCache.keys();
      for (let i = 0; i < 80; i += 1) {
        const k = it.next().value;
        if (!k) break;
        state.langDetectCache.delete(k);
      }
    }
    return lang;
  }

  function stopSpeaking() {
    try {
      chrome.runtime.sendMessage({ type: "VT_TTS_STOP" }).catch(() => {});
    } catch {
      // ignore
    }
    try {
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
    state.ttsActive.clear();
    state.ttsOutstanding.clear();
    for (const t of state.ttsTimeouts.values()) {
      try {
        window.clearTimeout(t);
      } catch {
        // ignore
      }
    }
    state.ttsTimeouts.clear();
    if (state.proactivePauseTimer) {
      try {
        window.clearTimeout(state.proactivePauseTimer);
      } catch {
        // ignore
      }
      state.proactivePauseTimer = 0;
    }
    if (state.lagPauseTimer) {
      try {
        window.clearTimeout(state.lagPauseTimer);
      } catch {
        // ignore
      }
      state.lagPauseTimer = 0;
    }
    if (state.lagPulseTimer) {
      try {
        window.clearTimeout(state.lagPulseTimer);
      } catch {
        // ignore
      }
      state.lagPulseTimer = 0;
    }
    if (state.domPending?.timer) {
      try {
        window.clearTimeout(state.domPending.timer);
      } catch {
        // ignore
      }
    }
    if (state.domPending?.maxTimer) {
      try {
        window.clearTimeout(state.domPending.maxTimer);
      } catch {
        // ignore
      }
    }
    state.domPending = null;
    state.speakQueue = [];
    state.drainingQueue = false;
    maybeResumeAfterLag();
  }

  function applyAudioMix() {
    const v = state.currentVideo;
    if (!v) return;
    if (!state.settings.reading) return;
    if (!state.videoMuteSnapshot || state.videoMuteSnapshot.video !== v) {
      state.videoMuteSnapshot = { video: v, muted: v.muted, volume: v.volume };
    }

    const snap = state.videoMuteSnapshot;
    const mix = clamp(Number(state.settings.audioMix) || 0, 0, 1);
    // Equal-power crossfade (more natural than linear).
    const originalGain = Math.sqrt(1 - mix);
    const wantMute = originalGain <= 0.05;
    try {
      // Preserve original "muted" if the user had it muted already.
      v.muted = snap.muted ? true : wantMute;
      v.volume = snap.muted ? 0 : clamp(snap.volume * originalGain, 0, 1);
    } catch {
      // ignore
    }
  }

  function restoreAudio() {
    const v = state.currentVideo;
    if (!v) return;
    const snap = state.videoMuteSnapshot;
    if (!snap || snap.video !== v) return;
    try {
      v.muted = snap.muted;
      v.volume = snap.volume;
    } catch {
      // ignore
    }
  }

  function applyPlaybackRate(targetRate, opts = {}) {
    const v = state.currentVideo;
    if (!v) return;

    if (opts.restore || !state.settings.reading || !state.settings.slowVideo) {
      const snap = state.videoRateSnapshot;
      if (snap && snap.video === v) {
        try {
          v.playbackRate = snap.rate;
        } catch {
          // ignore
        }
      }
      return;
    }

    if (!state.videoRateSnapshot || state.videoRateSnapshot.video !== v) {
      state.videoRateSnapshot = { video: v, rate: v.playbackRate };
    }

    if (typeof targetRate !== "number") return;
    const r = clamp(targetRate, 0.25, state.videoRateSnapshot.rate || 1.0);
    try {
      v.playbackRate = r;
    } catch {
      // ignore
    }
  }

  function isLagging() {
    if (!state.settings.reading || !state.settings.slowVideo) return false;
    return state.ttsOutstanding.size > 0 || (state.speakQueue && state.speakQueue.length > 0);
  }

  function isBehindNow() {
    if (!state.settings.reading || !state.settings.slowVideo) return false;
    if (!(state.ttsOutstanding.size > 0 && state.speakQueue && state.speakQueue.length >= 1)) return false;
    return (state.ttsEstEndAt || 0) - Date.now() > 250;
  }

  function computeLagPulseMs() {
    const backlog = (state.speakQueue ? state.speakQueue.length : 0) + (state.ttsOutstanding.size > 0 ? 1 : 0);
    const base = typeof state.settings.baseSpeechRate === "number" ? state.settings.baseSpeechRate : DEFAULTS.baseSpeechRate;
    const slowFactor = clamp(1.2 / Math.max(0.4, base), 0.7, 2.4);
    const ms = (620 + backlog * 420) * slowFactor;
    return clamp(ms, LAG_PULSE_MIN_MS, LAG_PULSE_MAX_MS);
  }

  function computeLagCooldownMs(pulseMs) {
    const backlog = (state.speakQueue ? state.speakQueue.length : 0) + (state.ttsOutstanding.size > 0 ? 1 : 0);
    const mult = backlog >= 3 ? 1.15 : 1.75;
    return clamp(pulseMs * mult, LAG_COOLDOWN_MIN_MS, LAG_COOLDOWN_MAX_MS);
  }

  function requestLagPause() {
    if (state.lagPauseTimer) return;
    if (!isBehindNow()) return;
    const now = Date.now();
    const pulseMs = computeLagPulseMs();
    const cooldown = computeLagCooldownMs(pulseMs);
    if (now - (state.lastLagPauseAt || 0) < cooldown) return;
    state.lagPauseTimer = window.setTimeout(() => {
      state.lagPauseTimer = 0;
      pauseNowForLag();
    }, LAG_PAUSE_GRACE_MS);
  }

  function pauseNowForLag() {
    const v = state.currentVideo;
    if (!v) return;
    if (!state.settings.reading || !state.settings.slowVideo) return;
    if (!isBehindNow()) return;
    if (v.paused) return;

    state.wasPausedBeforeExt = !!v.paused;
    state.pausedByExt = true;
    state.lagPaused = true;
    state.lastLagPauseAt = Date.now();

    try {
      v.pause();
    } catch {
      // ignore
    }

    const pulseMs = computeLagPulseMs();
    if (state.lagPulseTimer) {
      try {
        window.clearTimeout(state.lagPulseTimer);
      } catch {
        // ignore
      }
      state.lagPulseTimer = 0;
    }
    state.lagPulseTimer = window.setTimeout(() => {
      state.lagPulseTimer = 0;
      if (!state.pausedByExt || !state.lagPaused) return;
      state.pausedByExt = false;
      state.lagPaused = false;
      if (!state.wasPausedBeforeExt) {
        try {
          void v.play();
        } catch {
          // ignore
        }
      }
    }, pulseMs);
  }

  function pausePulseMs(ms) {
    const v = state.currentVideo;
    if (!v) return;
    if (!state.settings.reading || !state.settings.slowVideo) return;
    if (v.paused) return;
    const now = Date.now();
    if (now - (state.lastLagPauseAt || 0) < 1200) return;

    state.wasPausedBeforeExt = !!v.paused;
    state.pausedByExt = true;
    state.lagPaused = true;
    state.lastLagPauseAt = now;

    try {
      v.pause();
    } catch {
      // ignore
    }

    const pulseMs = clamp(Number(ms) || 0, 400, 3500);
    if (state.lagPulseTimer) {
      try {
        window.clearTimeout(state.lagPulseTimer);
      } catch {
        // ignore
      }
      state.lagPulseTimer = 0;
    }
    state.lagPulseTimer = window.setTimeout(() => {
      state.lagPulseTimer = 0;
      if (!state.pausedByExt || !state.lagPaused) return;
      state.pausedByExt = false;
      state.lagPaused = false;
      if (!state.wasPausedBeforeExt) {
        try {
          void v.play();
        } catch {
          // ignore
        }
      }
    }, pulseMs);
  }

  function maybeResumeAfterLag() {
    const v = state.currentVideo;
    if (!v) return;
    if (!state.settings.reading || !state.settings.slowVideo) return;
    if (!state.lagPaused) return;
    if (isLagging()) return;
    if (!state.pausedByExt) {
      state.lagPaused = false;
      return;
    }
    state.pausedByExt = false;
    state.lagPaused = false;
    if (state.lagPauseTimer) {
      try {
        window.clearTimeout(state.lagPauseTimer);
      } catch {
        // ignore
      }
      state.lagPauseTimer = 0;
    }
    if (state.lagPulseTimer) {
      try {
        window.clearTimeout(state.lagPulseTimer);
      } catch {
        // ignore
      }
      state.lagPulseTimer = 0;
    }
    if (!state.wasPausedBeforeExt) {
      try {
        void v.play();
      } catch {
        // ignore
      }
    }
  }

  // Back-compat: older builds paused while speaking; current build pauses only when behind.
  function applyPauseWhileSpeaking() {
    if (!state.settings.reading || !state.settings.slowVideo) {
      state.lagPaused = false;
      state.pausedByExt = false;
      state.wasPausedBeforeExt = false;
      return;
    }
    if (state.ttsOutstanding.size > 0) requestLagPause();
    else maybeResumeAfterLag();
  }

  function getDomCaptionText() {
    const host = location.host || "";

    // YouTube (including auto-translated captions).
    if (host.includes("youtube.com") || host.includes("youtu.be")) {
      const segs = document.querySelectorAll(".ytp-caption-window-container .ytp-caption-segment");
      if (segs && segs.length) {
        const visible = Array.from(segs).filter((el) => {
          try {
            return el.getClientRects().length > 0;
          } catch {
            return true;
          }
        });
        const t = safeText(visible.map((s) => s.textContent || "").join(" "));
        if (t) return t;
      }
      // IMPORTANT: On YouTube, do NOT fall back to generic page selectors (they often match the video title/metadata).
      return "";
    }

    // Common players.
    const selectors = [
      ".vjs-text-track-display",
      ".jw-text-track-display",
      ".shaka-text-container",
      ".dashjs-text-container",
      "[class*='caption'] [class*='text']",
      "[class*='subtitle']",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const t = safeText(el.textContent || "");
      if (t) return t;
    }
    return "";
  }

  function isLikelyTitleOrMetadata(text) {
    const t = safeText(text).toLowerCase();
    if (!t) return false;
    // Filter exact matches to document title.
    const doc = safeText(document.title || "")
      .replace(/\s+-\s+youtube\s*$/i, "")
      .toLowerCase();
    if (doc && (t === doc || t === (doc + " - youtube"))) return true;
    // YouTube watch page title element.
    const ytTitle = safeText(document.querySelector("h1.ytd-watch-metadata")?.textContent || "").toLowerCase();
    if (ytTitle && t === ytTitle) return true;
    return false;
  }

  function estimateSpeechSeconds(text) {
    const t = safeText(text);
    if (!t) return 0.1;
    const words = t.includes(" ") ? t.split(" ").filter(Boolean).length : 0;
    const chars = t.length;
    // Rough base: ~2.7 words/sec OR ~14 chars/sec at rate 1.0
    const byWords = words > 0 ? words / 2.7 : 0;
    const byChars = chars / 14.0;
    const est = Math.max(byWords, byChars);
    return Math.max(0.25, est);
  }

  function resolveTtsLang(detectedLang) {
    const chosen = String(state.settings.targetLang || "auto");
    const norm = (x) => {
      const t = String(x || "");
      if (!t) return "";
      if (t === "zh") return "zh-CN";
      return t;
    };
    if (chosen && chosen !== "auto") return norm(chosen);
    return norm(detectedLang) || "en";
  }

  function _stripLeadingJunk(s) {
    return String(s || "").replace(/^[\s.,!?;:，。！？；：、\-–—"“”'‘’()\\[\\]{}]+/, "");
  }

  function computeSpeechTextFromCaptionNorm(curNorm, prevNorm, ageMs) {
    const cur = normalizeCaptionKey(curNorm);
    const prev = normalizeCaptionKey(prevNorm);
    if (!cur) return "";
    if (prev && cur === prev) return "";
    if (prev && softNormalizeForDedupe(cur) === softNormalizeForDedupe(prev)) return "";

    // If captions are incrementally expanding (common on YouTube), speak only the new suffix.
    if (prev && ageMs < 2500 && cur.startsWith(prev) && cur.length > prev.length) {
      const suffix = _stripLeadingJunk(cur.slice(prev.length));
      // If the suffix is only punctuation/whitespace, ignore it.
      // Otherwise: speak it, even if it's short (e.g. "I", "to") to avoid skipping words.
      const meaningful = /[^\s.,!?;:，。！？；：、\-–—"“”'‘’()\[\]{}]/.test(suffix);
      if (meaningful) return suffix;
      return "";
    }

    // Captions sometimes "reflow" or slightly rewrite the same sentence (line breaks, punctuation),
    // which can cause repeated words. Try to speak only the truly new suffix by detecting overlaps.
    if (prev && ageMs < 3000) {
      // If the new caption is mostly contained in the previous one, treat it as a reflow (do not re-speak).
      const sp = softNormalizeForDedupe(prev);
      const sc = softNormalizeForDedupe(cur);
      if (sc && sp && sp.includes(sc) && sc.length >= Math.min(sp.length, 18)) return "";

      const splitWords = (s) => safeText(s).split(" ").filter(Boolean);
      const prevWords = splitWords(prev);
      const curWords = splitWords(cur);
      if (prevWords.length && curWords.length) {
        const tokenKey = (w) => {
          const t = String(w || "").toLowerCase();
          try {
            return t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
          } catch {
            return t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
          }
        };
        const p = prevWords.map(tokenKey).filter(Boolean);
        const c = curWords.map(tokenKey).filter(Boolean);
        if (p.length >= 2 && c.length >= 2) {
          // Find the largest k where prev tail matches cur head (word-level).
          const maxK = Math.min(p.length, c.length, 10);
          let bestK = 0;
          for (let k = maxK; k >= 2; k -= 1) {
            let ok = true;
            for (let i = 0; i < k; i += 1) {
              if (p[p.length - k + i] !== c[i]) {
                ok = false;
                break;
              }
            }
            if (ok) {
              bestK = k;
              break;
            }
          }
          if (bestK > 0) {
            const remainder = _stripLeadingJunk(curWords.slice(bestK).join(" "));
            const meaningful = /[^\s.,!?;:，。！？；：、\-–—"“”'‘’()\[\]{}]/.test(remainder);
            if (meaningful) return remainder;
            return "";
          }
        }
      }
    }

    return cur;
  }

  async function drainSpeakQueue() {
    if (state.drainingQueue) return;
    state.drainingQueue = true;
    try {
      if (!state.settings.speak || !state.settings.reading) return;
      if (state.ttsOutstanding.size > 0) return;
      const item = state.speakQueue[0];
      if (!item) return;
      state.lastSpokenNorm = normalizeCaptionKey(item.text);
      state.lastSpokenAt = Date.now();
      const fullNorm = normalizeCaptionKey(item.opts?.fullCaptionNorm || "");
      if (fullNorm) {
        state.lastSpokenFullNorm = fullNorm;
        state.lastSpokenFullAt = state.lastSpokenAt;
      }
      const started = await speak(item.text, { ...item.opts, interrupt: false, enqueue: false });
      if (started) {
        state.speakQueue.shift();
        return;
      }
      // Avoid "stuck" queues if TTS fails transiently; drop after a few tries.
      item.failCount = (Number(item.failCount) || 0) + 1;
      if (item.failCount >= 3) {
        state.speakQueue.shift();
        if (state.speakQueue.length > 0) void drainSpeakQueue();
      }
    } finally {
      state.drainingQueue = false;
    }
  }

  function enqueueCaptionSpeech(text, opts) {
    const cleaned = safeText(text);
    if (!cleaned) return;
    // If the user crossfaded all the way to Original audio, don't queue speech (it will "stop" on a failed speak()).
    const mix = clamp(Number(state.settings.audioMix) || 0, 0, 1);
    if (mix <= 0.02) return;
    const norm = normalizeCaptionKey(cleaned);
    const now = Date.now();
    if (norm && norm === state.lastSpokenNorm && now - (state.lastSpokenAt || 0) < 9000) return;
    const fullNorm = normalizeCaptionKey(opts?.fullCaptionNorm || "");
    if (fullNorm && fullNorm === state.lastSpokenFullNorm && now - (state.lastSpokenFullAt || 0) < 9000) return;
    const last = state.speakQueue[state.speakQueue.length - 1];
    if (last && normalizeCaptionKey(last.text) === norm) return;
    if (last && fullNorm && normalizeCaptionKey(last.opts?.fullCaptionNorm || "") === fullNorm) return;

    // Extra short-segment dedupe: prevent "word stutter" when caption sources briefly rewrite the same token.
    // Only applies to very short segments and only over a short time window.
    try {
      const tiny = softNormalizeForDedupe(norm);
      const words = tiny ? tiny.split(" ").filter(Boolean) : [];
      const isTiny = norm.length <= 14 || words.length <= 2;
      if (isTiny && tiny) {
        const lastTinyAt = state.recentCaptionTextAt.get(`spoken:${tiny}`) || 0;
        if (now - lastTinyAt < 2600) return;
        state.recentCaptionTextAt.set(`spoken:${tiny}`, now);
      }
    } catch {
      // ignore
    }

    state.speakQueue.push({ text: cleaned, opts: { ...(opts || {}) }, failCount: 0 });
    // Keep queue small to avoid falling far behind, but don't drop everything (skips).
    while (state.speakQueue.length > 3) state.speakQueue.shift();
    void drainSpeakQueue();
    // If a new caption arrives while we are already speaking, we're behind: request a short pause pulse.
    if (state.settings.reading && state.settings.slowVideo && state.ttsOutstanding.size > 0) requestLagPause();
  }

  function trackOutstanding(id, estMs) {
    if (!id) return;
    state.ttsOutstanding.add(id);
    const ms = clamp(Number(estMs) || 0, 400, 60_000);
    state.ttsEstEndAt = Math.max(state.ttsEstEndAt || 0, Date.now() + ms);
    const old = state.ttsTimeouts.get(id);
    if (old) {
      try {
        window.clearTimeout(old);
      } catch {
        // ignore
      }
    }
    const t = window.setTimeout(() => {
      state.ttsTimeouts.delete(id);
      state.ttsActive.delete(id);
      state.ttsOutstanding.delete(id);
      if (state.ttsOutstanding.size === 0) state.ttsEstEndAt = 0;
      if (state.speakQueue && state.speakQueue.length > 0) {
        void drainSpeakQueue();
        return;
      }
      maybeResumeAfterLag();
    }, ms);
    state.ttsTimeouts.set(id, t);
  }

  function untrackOutstanding(id) {
    if (!id) return;
    state.ttsActive.delete(id);
    state.ttsOutstanding.delete(id);
    const t = state.ttsTimeouts.get(id);
    if (t) {
      try {
        window.clearTimeout(t);
      } catch {
        // ignore
      }
      state.ttsTimeouts.delete(id);
    }
    if (state.ttsOutstanding.size === 0) state.ttsEstEndAt = 0;
    if (state.speakQueue && state.speakQueue.length > 0) {
      void drainSpeakQueue();
      return;
    }
    maybeResumeAfterLag();
  }

  async function speak(text, opts = {}) {
    if (!state.settings.speak) return false;
    const mix = clamp(Number(state.settings.audioMix) || 0, 0, 1);
    if (mix <= 0.02) return false; // original-only
    const lang = resolveTtsLang(opts.lang);
    const base = typeof state.settings.baseSpeechRate === "number" ? state.settings.baseSpeechRate : DEFAULTS.baseSpeechRate;
    const maxRate = 3.5;
    const minRate = 0.4;
    const rate = typeof opts.rate === "number" ? clamp(opts.rate, minRate, maxRate) : clamp(base, minRate, maxRate);
    const interrupt = opts.interrupt !== false;
    const enqueue = opts.enqueue !== false; // default true to avoid fragmenting speech
    const volume = clamp(Math.sqrt(mix), 0, 1);
    // Fallback timeout when TTS events aren't delivered (MV3 service worker can be flaky).
    const speechMs = (estimateSpeechSeconds(text) / Math.max(0.2, rate)) * 1000;
    const estMs = speechMs + 1200;

    // Proactive pause: if this caption window is shorter than the speech, pause once near caption end.
    if (state.settings.reading && state.settings.slowVideo && typeof opts.durationSec === "number" && opts.durationSec > 0) {
      const capMs = clamp(opts.durationSec * 1000, 200, 12_000);
      const extra = speechMs - capMs;
      if (extra > 350 && !state.proactivePauseTimer) {
        state.proactivePauseTimer = window.setTimeout(() => {
          state.proactivePauseTimer = 0;
          if (!state.settings.reading || !state.settings.slowVideo) return;
          if (state.ttsOutstanding.size <= 0) return;
          // Pause just long enough to let speech catch up, but cap it to avoid jarring pauses.
          pausePulseMs(extra + 200);
        }, capMs + 60);
      }
    }

    // Prefer background-driven chrome.tts for clearer voices.
    let utteranceId = "";
    try {
      utteranceId = `vt_${Date.now()}_${state.ttsNextId++}`;
      trackOutstanding(utteranceId, estMs);
      const res = await chrome.runtime.sendMessage({
        type: "VT_TTS_SPEAK",
        text,
        lang,
        rate,
        pitch: 1.0,
        volume,
        interrupt,
        enqueue,
        utteranceId,
      });
      if (res && res.ok) return true;
      untrackOutstanding(utteranceId);
    } catch {
      if (utteranceId) untrackOutstanding(utteranceId);
      // fall back
    }

    if ("speechSynthesis" in window) {
      const uid = `ws_${Date.now()}_${state.ttsNextId++}`;
      trackOutstanding(uid, estMs);
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = lang;
      utter.rate = rate;
      utter.volume = volume;
      const voices = window.speechSynthesis.getVoices?.() || [];
      const want = String(lang || "").toLowerCase();
      const score = (name) => {
        const n = String(name || "").toLowerCase();
        let s = 0;
        if (n.includes("google")) s += 50;
        if (n.includes("natural")) s += 20;
        if (n.includes("enhanced")) s += 20;
        if (n.includes("premium")) s += 20;
        if (n.includes("neural")) s += 10;
        return s;
      };
      const candidates = voices.filter((v) => String(v.lang || "").toLowerCase().startsWith(want));
      const pool = candidates.length ? candidates : voices;
      let best = pool[0] || null;
      let bestScore = best ? score(best.name) : -1;
      for (const v of pool) {
        const sc = score(v.name);
        if (sc > bestScore) {
          best = v;
          bestScore = sc;
        }
      }
      if (best) utter.voice = best;
      if (interrupt) window.speechSynthesis.cancel();
      utter.onstart = () => {
        state.ttsActive.add(uid);
      };
      utter.onend = () => {
        untrackOutstanding(uid);
      };
      utter.onerror = () => {
        untrackOutstanding(uid);
      };
      window.speechSynthesis.speak(utter);
      return true;
    }
    return false;
  }

  async function handleCaption(text, meta) {
    const cleaned = safeText(text);
    if (!cleaned) return;
    const wasSpeaking = state.ttsOutstanding.size > 0;

    // Cross-source dedupe: the same caption can arrive via DOM + track (or DOM rerenders).
    // Use a rolling window keyed by normalized caption text to prevent repeated lines.
    const captionKey = softNormalizeForDedupe(cleaned) || normalizeCaptionKey(cleaned);
    const now0 = Date.now();
    const sameTextDedupeMs =
      meta?.source === "Manual" ? 0 : typeof meta?.sameTextDedupeMs === "number" ? meta.sameTextDedupeMs : 12000;
    if (sameTextDedupeMs > 0 && captionKey) {
      const lastAt = state.recentCaptionTextAt.get(captionKey) || 0;
      if (now0 - lastAt < sameTextDedupeMs) return;
      state.recentCaptionTextAt.set(captionKey, now0);
      if (state.recentCaptionTextAt.size > 600) {
        for (const [k, t] of state.recentCaptionTextAt) {
          if (now0 - t > 30_000) state.recentCaptionTextAt.delete(k);
        }
      }
    }

    const key = safeText(meta?.key || cleaned);
    if (key && key === state.lastHandledKey) return;
    state.lastHandledKey = key;

    const now = Date.now();
    const last = state.recentCaptionAt.get(key) || 0;
    const dedupeMs = typeof meta?.dedupeMs === "number" ? meta.dedupeMs : 1800;
    if (now - last < dedupeMs) return;
    state.recentCaptionAt.set(key, now);
    if (state.recentCaptionAt.size > 400) {
      // Simple prune.
      for (const [k, t] of state.recentCaptionAt) {
        if (now - t > 30_000) state.recentCaptionAt.delete(k);
      }
    }

    appendBubble("me", meta?.source || "Caption", cleaned);
    // No external translation APIs: we speak the caption text as-is (it may already be auto-translated by the site).
    try {
      const t = await translateText(cleaned);
      const wantDetect = String(state.settings.targetLang || "auto") === "auto";
      const detectOk = !!(meta?.isCaption || meta?.source === "Manual");
      const ttsLang = wantDetect && detectOk ? await autoDetectYouTubeLang(t) : null;
      const durationSec = typeof meta?.durationSec === "number" ? meta.durationSec : null;
      let rate = typeof state.settings.baseSpeechRate === "number" ? state.settings.baseSpeechRate : DEFAULTS.baseSpeechRate;
      const enqueue = true;
      const interrupt = false;
      const now = Date.now();
      const curNorm = normalizeCaptionKey(t);
      const prevNorm = state.lastCaptionFullNorm || "";
      const ageMs = now - (state.lastCaptionFullAt || 0);

      if (state.settings.syncSpeech && durationSec && durationSec > 0.15) {
        // Keep speech at the user's chosen speed; do not change the video speed.
        rate = typeof state.settings.baseSpeechRate === "number" ? state.settings.baseSpeechRate : DEFAULTS.baseSpeechRate;
      }
      const speakText = computeSpeechTextFromCaptionNorm(curNorm, prevNorm, ageMs);
      state.lastCaptionFullNorm = curNorm;
      state.lastCaptionFullAt = now;
      if (speakText) {
        enqueueCaptionSpeech(speakText, {
          rate,
          interrupt,
          enqueue,
          lang: ttsLang || undefined,
          fullCaptionNorm: curNorm,
          durationSec: durationSec || undefined,
        });
      }
      if (state.settings.slowVideo && wasSpeaking) requestLagPause();
    } catch {
      const wantDetect = String(state.settings.targetLang || "auto") === "auto";
      const detectOk = !!(meta?.isCaption || meta?.source === "Manual");
      const ttsLang = wantDetect && detectOk ? await autoDetectYouTubeLang(cleaned) : null;
      const now = Date.now();
      const curNorm = normalizeCaptionKey(cleaned);
      const prevNorm = state.lastCaptionFullNorm || "";
      const ageMs = now - (state.lastCaptionFullAt || 0);
      const speakText = computeSpeechTextFromCaptionNorm(curNorm, prevNorm, ageMs);
      state.lastCaptionFullNorm = curNorm;
      state.lastCaptionFullAt = now;
      if (speakText) {
        enqueueCaptionSpeech(speakText, {
          interrupt: false,
          enqueue: true,
          lang: ttsLang || undefined,
          fullCaptionNorm: curNorm,
          durationSec: typeof meta?.durationSec === "number" ? meta.durationSec : undefined,
        });
      }
      if (state.settings.slowVideo && wasSpeaking) requestLagPause();
    }
  }

  function queueDomCaption(txt) {
    const cleaned = normalizeCaptionKey(txt);
    if (!cleaned) return;
    if (isLikelyTitleOrMetadata(cleaned)) return;
    if (state.domPending) {
      if (state.domPending.text === cleaned) return;
      state.domPending.text = cleaned;
      // Reset only the stability timer; keep a max-wait timer so we never get stuck silent.
      if (state.domPending.timer) {
        try {
          window.clearTimeout(state.domPending.timer);
        } catch {
          // ignore
        }
      }
      state.domPending.timer = window.setTimeout(() => {
        commitDomCaption();
      }, DOM_STABLE_MS);
      return;
    }

    const pending = {
      text: cleaned,
      at: Date.now(),
      timer: 0,
      maxTimer: 0,
    };
    pending.timer = window.setTimeout(() => {
      commitDomCaption();
    }, DOM_STABLE_MS);
    pending.maxTimer = window.setTimeout(() => {
      commitDomCaption();
    }, DOM_MAX_WAIT_MS);
    state.domPending = pending;
  }

  function commitDomCaption() {
    const pending = state.domPending;
    if (!pending) return;
    if (pending.timer) {
      try {
        window.clearTimeout(pending.timer);
      } catch {
        // ignore
      }
    }
    if (pending.maxTimer) {
      try {
        window.clearTimeout(pending.maxTimer);
      } catch {
        // ignore
      }
    }
    state.domPending = null;
    if (!state.settings.reading) return;
    const txt = pending.text;
    if (!txt) return;
    const now = Date.now();
    state.lastDomCaption = txt;
    state.lastDomAt = now;

    // Estimate caption window from observed on-screen pace.
    let durationSec = state.domPaceSec || 2.2;
    if (state.domLastCommitAt) {
      const interval = clamp((now - state.domLastCommitAt) / 1000, 0.35, 8.0);
      state.domPaceSec = clamp(state.domPaceSec * 0.75 + interval * 0.25, 0.35, 8.0);
      durationSec = state.domPaceSec;
    }
    state.domLastCommitAt = now;

    const tkey = `dom:${txt}`;
    if (tkey === state.lastCueKey) return;
    state.lastCueKey = tkey;
    handleCaption(txt, { source: "Caption (on-screen)", key: tkey, isCaption: true, dedupeMs: 6000, durationSec }).catch(() => {});
  }

  function tickCaptions() {
    if (!state.mounted) return;
    if (!state.settings.reading) return;
    const v = state.currentVideo;
    if (!v) return;
    applyAudioMix();
    if (!state.settings.slowVideo) applyPlaybackRate(null);
    if (state.settings.speak && (Number(state.settings.audioMix) || 0) <= 0.02) {
      setStatus("Audio mix is set to Original only — drag it toward Spoken to hear TTS.");
    }

    const source = state.settings.captionSource || "auto";
    ensureTrackSelected();

    // 1) Track-based captions when available.
    const t = state.currentTrack;
    const trackHasCue = !!(t && t.activeCues && t.activeCues.length);
    let allowDomFallback = source === "dom" || source === "auto";
    if (source === "track" || source === "auto") {
      let useTrack = t;
      let hasCue = trackHasCue;
      if (useTrack) {
        const kind = String(useTrack.kind || "").toLowerCase();
        if (kind && kind !== "subtitles" && kind !== "captions") {
          useTrack = null;
          hasCue = false;
        }
      }
      if (!hasCue) {
        const t2 = findTrackWithActiveCue(v);
        if (t2) {
          setCurrentTrack(t2);
          useTrack = t2;
          hasCue = true;
        }
      }
      if (source === "track" && (!useTrack || !hasCue)) {
        // Some sites (including YouTube) won't expose usable TextTrack cues; fall back to DOM captions.
        allowDomFallback = true;
      } else if (useTrack) {
        let cue = null;
        try {
          const cues = useTrack.activeCues;
          if (cues && cues.length) cue = cues[0];
        } catch {
          // ignore
        }
        if (!cue) cue = pickCueFromCues(useTrack, v.currentTime);
        if (!cue) {
          if (source === "track") allowDomFallback = true;
        } else {
          const cueText = normalizeCaptionKey(cue.text || "");
          if (!cueText || isLikelyTitleOrMetadata(cueText)) {
            // If the chosen track isn't giving meaningful captions, fall back to DOM captions.
            if (source !== "track") allowDomFallback = true;
          } else {
            const key = `track:${quantTime(cue.startTime, 0.1).toFixed(1)}:${quantTime(cue.endTime, 0.1).toFixed(1)}:${cueText}`;
            if (key === state.lastCueKey) return;
            state.lastCueKey = key;
            handleCaption(cueText, {
              source: "Caption (track)",
              key,
              isCaption: true,
              dedupeMs: 1200,
              durationSec: Math.max(0.05, Number(cue.endTime) - Number(cue.startTime)),
            }).catch(() => {});
            return;
          }
        }
      }
    }

    // 2) On-screen captions (DOM), works with YouTube auto-translate captions.
    if (allowDomFallback) {
      const txt = normalizeCaptionKey(getDomCaptionText());
      if (!txt) return;
      if (isLikelyTitleOrMetadata(txt)) return;
      queueDomCaption(txt);
    }

    // Keep pause/resume decisions responsive even if caption commits are delayed (DOM debounce).
    applyPauseWhileSpeaking();

    // Speech watchdog: if anything is queued and TTS is idle, keep draining.
    if (state.speakQueue && state.speakQueue.length > 0 && state.ttsOutstanding.size === 0) {
      void drainSpeakQueue();
    }
  }

  function loop() {
    try {
      tickCaptions();
    } finally {
      window.setTimeout(loop, 200);
    }
  }

  function refreshVideoAndTracks() {
    const v = pickBestVideo();
    if (v && v !== state.currentVideo) {
      state.currentVideo = v;
      // Reset snapshot for new video (applyMuteVideo will recreate it if needed).
      state.videoMuteSnapshot = null;
      state.videoRateSnapshot = null;
      state.pausedByExt = false;
      setStatus(state.settings.reading ? "Video found. Checking captions…" : "Video found. Press Read to start.");
      refreshTrackSelect();
    } else if (!v) {
      state.currentVideo = null;
      state.currentTrack = null;
      setStatus("No video detected on this page.");
      refreshTrackSelect();
    } else {
      // same video: tracks can appear later
      refreshTrackSelect();
      if (state.currentTrack) {
        setStatus(
          state.settings.reading
            ? "Listening to captions… (turn on subtitles; for translation use the site's caption auto-translate)"
            : "Ready. Turn on subtitles, then press Read."
        );
      } else {
        setStatus(state.settings.reading ? "Looking for captions… (turn on subtitles)" : "Ready. Turn on subtitles, then press Read.");
      }
    }
  }

  function attachObservers() {
    const mo = new MutationObserver(() => refreshVideoAndTracks());
    mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    window.addEventListener("resize", () => refreshVideoAndTracks(), { passive: true });
    window.addEventListener("focus", () => refreshVideoAndTracks(), { passive: true });
    window.setInterval(() => refreshVideoAndTracks(), 1500);
  }

  async function boot() {
    await loadSettings();
    if (!state.settings.enabledGlobal) return;
    injectUI();
    refreshVideoAndTracks();
    attachObservers();
    maybeShowDonatePrompt(true).catch(() => {});
    window.setInterval(() => maybeShowDonatePrompt(false).catch(() => {}), 30_000);
    loop();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "VT_TTS_EVENT") {
      const ev = msg.event || {};
      const uid = String(msg.utteranceId || ev.utteranceId || "");
      const t = String(ev.type || "");
      if (uid) {
        if (t === "start") state.ttsActive.add(uid);
        if (t === "end" || t === "interrupted" || t === "cancelled" || t === "error") {
          untrackOutstanding(uid);
        }
      }
      sendResponse?.({ ok: true });
      return;
    }
    if (msg.type === "VT_OPEN") {
      if (!state.mounted) {
        boot().catch(() => {});
      } else {
        toggleOpen(true);
      }
      maybeShowDonatePrompt(false).catch(() => {});
      sendResponse?.({ ok: true });
      return;
    }
    if (msg.type === "VT_NAV") {
      const view = msg.view;
      if (!state.mounted) {
        boot().catch(() => {});
      } else {
        toggleOpen(true);
      }
      if (view === "donate") setView("donate");
      if (view === "video") setView("video");
      sendResponse?.({ ok: true });
      return;
    }
    if (msg.type === "VT_CONTROL") {
      const action = msg.action;
      if (!state.mounted) {
        boot().catch(() => {});
      } else {
        toggleOpen(true);
      }
      if (action === "start") {
        state.settings.reading = true;
        state.settings.speak = true;
        chrome.storage.sync.set({ reading: true, speak: true, enabledGlobal: true }).catch(() => {});
        if (state.ui.reading) state.ui.reading.checked = true;
        if (state.ui.speak) state.ui.speak.checked = true;
        if (state.ui.mix) state.ui.mix.value = String(state.settings.audioMix ?? DEFAULTS.audioMix);
        if (state.ui.sync) state.ui.sync.checked = state.settings.syncSpeech !== false;
        if (state.ui.slow) state.ui.slow.checked = !!state.settings.slowVideo;
        if (state.ui.speed) state.ui.speed.value = String(state.settings.baseSpeechRate ?? DEFAULTS.baseSpeechRate);
        setStatus("Reading captions…");
        state.lastCueKey = "";
        state.lastHandledKey = "";
        state.recentCaptionAt.clear();
        state.recentCaptionTextAt.clear();
        state.lastSpokenNorm = "";
        state.lastSpokenAt = 0;
        state.lastSpokenFullNorm = "";
        state.lastSpokenFullAt = 0;
        applyPlaybackRate(null, { restore: true });
        applyAudioMix();
        refreshVideoAndTracks();
      } else if (action === "stop") {
        stopSpeaking();
        applyPlaybackRate(null, { restore: true });
        restoreAudio();
        state.ttsActive.clear();
        state.ttsOutstanding.clear();
        maybeResumeAfterLag();
        state.settings.reading = false;
        state.settings.speak = false;
        chrome.storage.sync.set({ reading: false, speak: false }).catch(() => {});
        if (state.ui.reading) state.ui.reading.checked = false;
        if (state.ui.speak) state.ui.speak.checked = false;
        state.lastCueKey = "";
        state.lastHandledKey = "";
        state.recentCaptionAt.clear();
        state.recentCaptionTextAt.clear();
        state.lastSpokenNorm = "";
        state.lastSpokenAt = 0;
        state.lastSpokenFullNorm = "";
        state.lastSpokenFullAt = 0;
        setStatus("Stopped.");
      }
      sendResponse?.({ ok: true });
      return;
    }
    if (msg.type === "VT_SETTINGS") {
      const prevTargetLang = String(state.settings.targetLang || "auto");
      state.settings = { ...state.settings, ...(msg.settings || {}) };
      if (state.settings.audioMix == null && state.settings.muteVideo === true) state.settings.audioMix = 1.0;
      state.settings.audioMix = clamp(Number(state.settings.audioMix) || 0, 0, 1);
      state.settings.sidebarWidth = clamp(Number(state.settings.sidebarWidth) || DEFAULTS.sidebarWidth, 180, Math.floor(window.innerWidth * 0.85));
      if (!state.settings.enabledGlobal) {
        if (state.mounted) toggleOpen(false);
        sendResponse?.({ ok: true });
        return;
      }
      if (!state.mounted) injectUI();
      toggleOpen(true);
      if (state.ui.host) state.ui.host.style.width = `${state.settings.sidebarWidth || 380}px`;
      state.ui.lang.value = state.settings.targetLang || state.ui.lang.value;
      state.ui.speak.checked = !!state.settings.speak;
      if (state.ui.reading) state.ui.reading.checked = !!state.settings.reading;
      if (state.ui.mix) state.ui.mix.value = String(state.settings.audioMix ?? DEFAULTS.audioMix);
      if (state.ui.sync) state.ui.sync.checked = state.settings.syncSpeech !== false;
      if (state.ui.slow) state.ui.slow.checked = !!state.settings.slowVideo;
      if (state.ui.speed) {
        const v = Number(state.settings.baseSpeechRate ?? DEFAULTS.baseSpeechRate);
        state.ui.speed.value = String(Number.isFinite(v) ? v : DEFAULTS.baseSpeechRate);
        if (state.ui.speedVal) state.ui.speedVal.textContent = `${Number(state.ui.speed.value).toFixed(2)}×`;
      }
      state.translateCache.clear();
      state.lastCueKey = "";
      state.lastHandledKey = "";
      if (String(state.settings.targetLang || "auto") !== prevTargetLang) resetCaptionPipelineForLanguageChange();
      if (!state.settings.reading) {
        state.recentCaptionAt.clear();
        state.recentCaptionTextAt.clear();
        state.lastSpokenNorm = "";
        state.lastSpokenAt = 0;
        state.lastSpokenFullNorm = "";
        state.lastSpokenFullAt = 0;
      }
      applyAudioMix();
      if (!state.settings.slowVideo) applyPlaybackRate(null, { restore: true });
      if (!state.settings.slowVideo) {
        state.lagPaused = false;
        state.pausedByExt = false;
      }
      refreshVideoAndTracks();
      sendResponse?.({ ok: true });
    }
  });

  // Boot immediately; popup can also open/focus it.
  boot().catch(() => {});
})();
