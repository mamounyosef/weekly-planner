"""The planner's local speech engine: voice mode hears and speaks through it.

Runs on this PC's GPU, free, and nothing it hears or says leaves the machine:

  hearing   Silero VAD (is someone talking, every 32 ms) + Whisper large-v3-turbo
  speaking  Kokoro 82M (English voices, American and British)

Started and supervised by the dev server (voice-service.ts), the only thing
that talks to it: browsers reach it through /api/voice/ws there, after the
planner's own sign-in. It listens on 127.0.0.1 only.

One WebSocket per voice session:

  browser -> here   binary  16 kHz mono int16 microphone frames
                    JSON    start, config, speak, cancel, playing, mute
  here -> browser   JSON    status, speech_start, partial, final, discard,
                            tts_done, error
                    binary  [uint32 speak id][int16 24 kHz mono PCM]

Models load on the first session and are dropped again after 20 idle minutes,
so the GPU memory (about 2 GB) is only held while voice mode is in use.

Run with the speech venv, never the launcher one (CUDA, Whisper, Kokoro):
    .venv-speech\\Scripts\\python.exe speech-server.py --port 5179
"""

import argparse
import asyncio
import gc
import glob
import io
import json
import os
import re
import struct
import sys
import threading
import time
import wave
from collections import deque
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(ROOT, "speech-models")
# The C: drive is nearly full; every model lives next to the repo on D:.
os.environ.setdefault("HF_HOME", os.path.join(MODELS_DIR, "hf"))
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")


def _add_cuda_dlls():
    """CUDA 12 cuBLAS and cuDNN come from pip wheels (nvidia-*-cu12), not a
    system install, so Windows has to be told where their DLLs are."""
    site = os.path.join(os.path.dirname(sys.executable), "..", "Lib", "site-packages")
    for d in glob.glob(os.path.join(site, "nvidia", "*", "bin")):
        d = os.path.abspath(d)
        try:
            os.add_dll_directory(d)
        except OSError:
            pass
        os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


_add_cuda_dlls()

import numpy as np  # noqa: E402
from aiohttp import WSMsgType, web  # noqa: E402

WHISPER_MODEL = "large-v3-turbo"
KOKORO_MODEL = os.path.join(MODELS_DIR, "kokoro-v1.0.onnx")
KOKORO_VOICES = os.path.join(MODELS_DIR, "voices-v1.0.bin")
TTS_RATE = 24000
MIC_RATE = 16000
FRAME = 512                 # samples per VAD frame (32 ms at 16 kHz)
FRAME_MS = FRAME * 1000 // MIC_RATE
IDLE_UNLOAD_S = 10 * 60
# GPU memory. Whisper's weights in 8-bit (about half of float16, the same
# accuracy for practical purposes), and Kokoro's onnxruntime held to what it
# actually needs: by default its CUDA arena grows in powers of two and cuDNN
# searches with huge workspaces, which is where most of a 4 GB footprint went.
# Overrides: SPEECH_WHISPER_COMPUTE (e.g. float16), SPEECH_TTS_DEVICE=cpu
# (Kokoro on the CPU: no GPU memory at all for speaking, a little slower).
WHISPER_COMPUTE = os.environ.get("SPEECH_WHISPER_COMPUTE", "int8_float16")
TTS_DEVICE = os.environ.get("SPEECH_TTS_DEVICE", "cuda").lower()
KOKORO_CUDA_OPTIONS = {
    "arena_extend_strategy": "kSameAsRequested",
    "cudnn_conv_algo_search": "HEURISTIC",
    "cudnn_conv_use_max_workspace": "0",
    # A ceiling, not a reservation: the arena only grows as far as it is used.
    "gpu_mem_limit": str(1536 * 1024 * 1024),
}
MAX_UTTERANCE_S = 45
PARTIAL_EVERY_S = 0.7

# The curated voice list: Kokoro's best-graded English voices only.
VOICES = [
    {"id": "af_heart", "name": "Heart", "accent": "American", "gender": "female", "note": "Warm and natural. The best Kokoro voice."},
    {"id": "af_bella", "name": "Bella", "accent": "American", "gender": "female", "note": "Bright and expressive."},
    {"id": "af_nicole", "name": "Nicole", "accent": "American", "gender": "female", "note": "Soft and calm, almost a whisper."},
    {"id": "af_aoede", "name": "Aoede", "accent": "American", "gender": "female", "note": "Smooth and relaxed."},
    {"id": "af_kore", "name": "Kore", "accent": "American", "gender": "female", "note": "Clear and confident."},
    {"id": "af_sarah", "name": "Sarah", "accent": "American", "gender": "female", "note": "Friendly and even."},
    {"id": "af_nova", "name": "Nova", "accent": "American", "gender": "female", "note": "Crisp and modern."},
    {"id": "af_sky", "name": "Sky", "accent": "American", "gender": "female", "note": "Light and airy."},
    {"id": "am_michael", "name": "Michael", "accent": "American", "gender": "male", "note": "Deep and steady."},
    {"id": "am_fenrir", "name": "Fenrir", "accent": "American", "gender": "male", "note": "Rich and full."},
    {"id": "am_puck", "name": "Puck", "accent": "American", "gender": "male", "note": "Lively and upbeat."},
    {"id": "am_echo", "name": "Echo", "accent": "American", "gender": "male", "note": "Calm and clear."},
    {"id": "am_eric", "name": "Eric", "accent": "American", "gender": "male", "note": "Plain and direct."},
    {"id": "am_liam", "name": "Liam", "accent": "American", "gender": "male", "note": "Young and easygoing."},
    {"id": "am_onyx", "name": "Onyx", "accent": "American", "gender": "male", "note": "Low and serious."},
    {"id": "bf_emma", "name": "Emma", "accent": "British", "gender": "female", "note": "Polished and warm."},
    {"id": "bf_isabella", "name": "Isabella", "accent": "British", "gender": "female", "note": "Elegant and gentle."},
    {"id": "bf_alice", "name": "Alice", "accent": "British", "gender": "female", "note": "Neat and precise."},
    {"id": "bf_lily", "name": "Lily", "accent": "British", "gender": "female", "note": "Soft and friendly."},
    {"id": "bm_george", "name": "George", "accent": "British", "gender": "male", "note": "Classic and composed."},
    {"id": "bm_fable", "name": "Fable", "accent": "British", "gender": "male", "note": "A storyteller."},
    {"id": "bm_lewis", "name": "Lewis", "accent": "British", "gender": "male", "note": "Grounded and calm."},
    {"id": "bm_daniel", "name": "Daniel", "accent": "British", "gender": "male", "note": "Measured and clear."},
]
VOICE_IDS = {v["id"] for v in VOICES}
DEFAULT_VOICE = "af_heart"

# What Whisper "hears" in silence or breath. Dropped only when the VAD was
# unsure the whole time, so a real, clearly spoken "thank you" still counts.
HALLUCINATIONS = {
    "you", "thank you", "thank you.", "thanks for watching", "thank you for watching",
    "thanks for watching!", "bye", "bye.", "okay", "so", "uh", "um", "hmm", "mm",
    "subtitles by the amara.org community", "please subscribe",
}
# A pause after one of these is the speaker gathering their thoughts, not the
# end of what they meant to say: wait longer before answering.
TRAILING_HOLD = re.compile(
    r"(\b(and|but|or|so|because|then|also|like|um|uh|er|the|a|an|to|for|with|at|on|in|of|my|is|are|if|when|that|which|maybe|actually)|,|-)\s*$",
    re.IGNORECASE,
)


def log(*parts):
    print(time.strftime("%H:%M:%S"), *parts, flush=True)


# ─── The engine: models, shared by every session ─────────────────────────────

class Engine:
    def __init__(self):
        self.lock = threading.Lock()
        self.whisper = None
        self.kokoro = None
        self.device = None
        self.vad = None
        self.loading = False
        self.error = None
        self.last_used = time.monotonic()
        # One worker each: the GPU runs one transcription and one voice at a
        # time, so a long reply never queues behind a partial transcript.
        self.stt_pool = ThreadPoolExecutor(1, "stt")
        self.tts_pool = ThreadPoolExecutor(1, "tts")

    @property
    def ready(self):
        return self.whisper is not None and self.kokoro is not None

    def load_vad(self):
        if self.vad is None:
            import onnxruntime as ort
            import faster_whisper
            path = os.path.join(os.path.dirname(faster_whisper.__file__), "assets", "silero_vad_v6.onnx")
            opts = ort.SessionOptions()
            opts.inter_op_num_threads = 1
            opts.intra_op_num_threads = 1
            opts.log_severity_level = 4
            self.vad = ort.InferenceSession(path, providers=["CPUExecutionProvider"], sess_options=opts)
        return self.vad

    def load(self):
        """Blocking. Safe to call from several threads; loads once."""
        with self.lock:
            if self.ready:
                return
            self.loading = True
            self.error = None
            t0 = time.time()
            try:
                import onnxruntime as ort
                from faster_whisper import WhisperModel
                from kokoro_onnx import Kokoro

                self.load_vad()
                try:
                    try:
                        whisper = WhisperModel(WHISPER_MODEL, device="cuda", compute_type=WHISPER_COMPUTE)
                    except Exception as e:
                        log("Whisper %s on the GPU failed, trying float16:" % WHISPER_COMPUTE, e)
                        whisper = WhisperModel(WHISPER_MODEL, device="cuda", compute_type="float16")
                    device = "cuda"
                except Exception as e:
                    log("Whisper on the GPU failed, using the CPU:", e)
                    whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
                    device = "cpu"
                opts = ort.SessionOptions()
                opts.log_severity_level = 3
                sess = ort.InferenceSession(
                    KOKORO_MODEL,
                    sess_options=opts,
                    providers=[("CUDAExecutionProvider", KOKORO_CUDA_OPTIONS), "CPUExecutionProvider"]
                    if device == "cuda" and TTS_DEVICE != "cpu" else ["CPUExecutionProvider"],
                )
                kokoro = Kokoro.from_session(sess, KOKORO_VOICES)
                # The first call of each model compiles kernels; pay that now,
                # not on the user's first sentence.
                kokoro.create("Ready.", voice=DEFAULT_VOICE, speed=1.0, lang="en-us")
                list(whisper.transcribe(np.zeros(MIC_RATE, np.float32), language="en", beam_size=1)[0])
                self.whisper, self.kokoro, self.device = whisper, kokoro, device
                log("Models ready on %s in %.1fs (Kokoro on %s)" % (device, time.time() - t0, sess.get_providers()[0]))
            except Exception as e:
                self.error = str(e)
                log("Loading the speech models failed:", repr(e))
                raise
            finally:
                self.loading = False
                self.last_used = time.monotonic()

    def unload(self):
        with self.lock:
            if not self.ready:
                return
            self.whisper = None
            self.kokoro = None
            gc.collect()
            log("Models unloaded after %d idle minutes" % (IDLE_UNLOAD_S // 60))

    def transcribe(self, audio, hints, final, prompt=None):
        """(text, mean no-speech probability). Partials use greedy decoding
        for speed; the final pass uses beam search for accuracy."""
        self.last_used = time.monotonic()
        segments, _info = self.whisper.transcribe(
            audio,
            language="en",
            beam_size=5 if final else 1,
            temperature=0.0,
            vad_filter=False,
            condition_on_previous_text=False,
            without_timestamps=True,
            # A punctuated, capitalised prompt keeps the beam-search pass
            # writing sentences too (without it, it came back all lower case
            # and unpunctuated), and the hints spell the planner's own words.
            # Another app (Notes) may send its own opening line instead.
            initial_prompt=((prompt or "Hi, okay. Let's plan my day.") + (" " + hints if hints else "")),
        )
        texts, nsp = [], []
        for s in segments:
            nsp.append(s.no_speech_prob)
            if s.no_speech_prob > 0.6 and s.avg_logprob < -0.8:
                continue
            texts.append(s.text)
        text = re.sub(r"\s+", " ", " ".join(texts)).strip()
        return text, (sum(nsp) / len(nsp) if nsp else 1.0)

    def speak(self, text, voice, speed):
        """int16 PCM at 24 kHz."""
        self.last_used = time.monotonic()
        voice = voice if voice in VOICE_IDS else DEFAULT_VOICE
        lang = "en-gb" if voice.startswith("b") else "en-us"
        samples, _sr = self.kokoro.create(text, voice=voice, speed=float(speed), lang=lang)
        samples = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
        return (samples * 32767.0).astype(np.int16)


ENGINE = Engine()
SESSIONS = set()


def clean_for_speech(text):
    """Last line of defence before the voice reads something: no markdown
    symbols, links or emoji read out loud."""
    t = re.sub(r"https?://\S+", "a link", text)
    t = re.sub(r"`([^`]*)`", r"\1", t)
    t = re.sub(r"[*_#>~|]+", " ", t)
    t = re.sub(r"[\U0001F000-\U0001FAFF☀-➿]", " ", t)
    t = t.replace("—", ", ").replace("–", ", ")
    return re.sub(r"\s+", " ", t).strip()


# ─── One voice session (one WebSocket) ───────────────────────────────────────

class Session:
    def __init__(self, ws):
        self.ws = ws
        self.loop = asyncio.get_running_loop()
        self.vad = ENGINE.load_vad()
        self.h = np.zeros((1, 1, 128), np.float32)
        self.c = np.zeros((1, 1, 128), np.float32)
        self.ctx = np.zeros(64, np.float32)
        self.pending = np.zeros(0, np.float32)
        self.preroll = deque(maxlen=10)      # 320 ms kept from before speech began
        self.speaking = False
        self.start_run = 0
        self.frames = []
        self.probs = []
        self.silence_ms = 0
        self.utt = 0
        self.finalized = set()
        self.partial_busy = False
        self.last_partial_at = 0.0
        self.last_partial = ""
        self.playing = False
        self.muted = False
        self.voice = DEFAULT_VOICE
        self.speed = 1.0
        # Set when the planner's server opened this session for a signed-in
        # user: the voice and speed then come from that user's saved settings
        # (shared by all their devices) and the page's own values are ignored.
        self.user = None
        self.endpoint_ms = 700
        self.hints = ""
        self.prompt = None
        self.tts_gen = 0
        self.tts_queue = asyncio.Queue()
        self.closed = False
        self.send_lock = asyncio.Lock()

    async def send_json(self, obj):
        if self.closed:
            return
        try:
            async with self.send_lock:
                await self.ws.send_str(json.dumps(obj))
        except Exception:
            self.closed = True

    async def send_bytes(self, data):
        if self.closed:
            return
        try:
            async with self.send_lock:
                await self.ws.send_bytes(data)
        except Exception:
            self.closed = True

    def set_voice(self, voice, speed):
        if voice in VOICE_IDS and voice != self.voice:
            log("voice now %s" % voice)
            self.voice = voice
        try:
            if speed is not None:
                self.speed = min(1.5, max(0.7, float(speed)))
        except (TypeError, ValueError):
            pass

    def configure(self, msg):
        if self.user is None:
            self.set_voice(msg.get("voice"), msg.get("speed"))
        try:
            self.endpoint_ms = int(min(2000, max(350, int(msg.get("endpointMs", self.endpoint_ms)))))
        except (TypeError, ValueError):
            pass
        if isinstance(msg.get("hints"), str):
            self.hints = msg["hints"][:600]
        if isinstance(msg.get("prompt"), str) and msg["prompt"].strip():
            self.prompt = msg["prompt"].strip()[:200]

    # ── hearing ──

    def _prob(self, frame):
        x = np.concatenate([self.ctx, frame])[None, :]
        out, self.h, self.c = self.vad.run(None, {"input": x, "h": self.h, "c": self.c})
        self.ctx = frame[-64:]
        return float(np.asarray(out).reshape(-1)[0])

    def feed(self, data):
        if self.muted or not ENGINE.ready:
            return
        pcm = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
        self.pending = np.concatenate([self.pending, pcm])
        while len(self.pending) >= FRAME:
            frame, self.pending = self.pending[:FRAME], self.pending[FRAME:]
            self._frame(frame)

    def _frame(self, frame):
        p = self._prob(frame)
        if not self.speaking:
            self.preroll.append(frame)
            # While the assistant talks, only a clear, sustained voice counts:
            # the echo cancellation leaves a little of its own voice behind.
            need, th = (8, 0.85) if self.playing else (3, 0.5)
            self.start_run = self.start_run + 1 if p >= th else 0
            if self.start_run >= need:
                self.speaking = True
                self.utt += 1
                self.frames = list(self.preroll)
                self.probs = [p]
                self.silence_ms = 0
                self.last_partial = ""
                self.last_partial_at = time.monotonic()
                self.preroll.clear()
                asyncio.ensure_future(self.send_json({"type": "speech_start", "utt": self.utt}))
            return
        self.frames.append(frame)
        self.probs.append(p)
        self.silence_ms = self.silence_ms + FRAME_MS if p < 0.35 else 0
        hold = self.endpoint_ms
        if self.last_partial and TRAILING_HOLD.search(self.last_partial):
            hold = min(2200, int(self.endpoint_ms * 1.9))
        too_long = len(self.frames) * FRAME_MS >= MAX_UTTERANCE_S * 1000
        if self.silence_ms >= hold or too_long:
            self._end_utterance()
            return
        now = time.monotonic()
        if not self.partial_busy and now - self.last_partial_at >= PARTIAL_EVERY_S and len(self.frames) * FRAME_MS > 600:
            self.last_partial_at = now
            self.partial_busy = True
            audio = np.concatenate(self.frames[-int(25000 / FRAME_MS):])
            asyncio.ensure_future(self._partial(self.utt, audio))

    def _end_utterance(self):
        self.speaking = False
        self.start_run = 0
        # Trim most of the trailing silence; keep a little so the last word is whole.
        keep = max(1, len(self.frames) - max(0, self.silence_ms - 250) // FRAME_MS)
        audio = np.concatenate(self.frames[:keep])
        probs = self.probs
        self.frames, self.probs = [], []
        asyncio.ensure_future(self._final(self.utt, audio, probs))

    async def _partial(self, utt, audio):
        try:
            text, _ = await self.loop.run_in_executor(ENGINE.stt_pool, ENGINE.transcribe, audio, self.hints, False, self.prompt)
            if utt == self.utt and utt not in self.finalized and text:
                self.last_partial = text
                await self.send_json({"type": "partial", "utt": utt, "text": text})
        except Exception as e:
            log("partial failed:", repr(e))
        finally:
            self.partial_busy = False

    async def _final(self, utt, audio, probs):
        self.finalized.add(utt)
        dur = len(audio) / MIC_RATE
        try:
            t0 = time.time()
            text, nsp = await self.loop.run_in_executor(ENGINE.stt_pool, ENGINE.transcribe, audio, self.hints, True, self.prompt)
            mean_p = float(np.mean(probs)) if probs else 0.0
            norm = re.sub(r"[^a-z' ]", "", text.lower()).strip()
            junk = not norm or (norm in HALLUCINATIONS and (mean_p < 0.7 or nsp > 0.5)) or (dur < 0.45 and mean_p < 0.6)
            log("heard %.1fs in %.2fs (vad %.2f, nsp %.2f)%s: %s" % (dur, time.time() - t0, mean_p, nsp, " DROPPED" if junk else "", text[:120]))
            if junk:
                await self.send_json({"type": "discard", "utt": utt})
            else:
                await self.send_json({"type": "final", "utt": utt, "text": text, "seconds": round(dur, 2)})
        except Exception as e:
            log("final failed:", repr(e))
            await self.send_json({"type": "discard", "utt": utt})
            await self.send_json({"type": "error", "message": "Could not transcribe that: %s" % e})

    # ── speaking ──

    def speak(self, sid, text, voice=None, speed=None):
        """Each sentence may name its own voice and speed: the page sends the
        current setting with every one, so a change in Settings applies to the
        very next sentence, whichever window it was made in."""
        text = clean_for_speech(text)
        if not text:
            return
        if self.user is None:
            self.set_voice(voice, speed)
        self.tts_queue.put_nowait((self.tts_gen, sid, text))

    def cancel_speech(self):
        self.tts_gen += 1
        while not self.tts_queue.empty():
            try:
                self.tts_queue.get_nowait()
            except asyncio.QueueEmpty:
                break

    async def tts_worker(self):
        while not self.closed:
            gen, sid, text = await self.tts_queue.get()
            if gen != self.tts_gen:
                continue
            try:
                pcm = await self.loop.run_in_executor(ENGINE.tts_pool, ENGINE.speak, text, self.voice, self.speed)
            except Exception as e:
                log("speech failed:", repr(e))
                await self.send_json({"type": "tts_done", "id": sid, "error": str(e)})
                continue
            if gen != self.tts_gen:
                continue
            head = struct.pack("<I", sid & 0xFFFFFFFF)
            step = TTS_RATE // 2  # half-second chunks: playback starts sooner, cancels sooner
            for i in range(0, len(pcm), step):
                if gen != self.tts_gen or self.closed:
                    break
                await self.send_bytes(head + pcm[i:i + step].tobytes())
            if gen == self.tts_gen:
                await self.send_json({"type": "tts_done", "id": sid})


async def ensure_loaded(session=None):
    if ENGINE.ready:
        return True
    if session:
        await session.send_json({"type": "status", "stage": "loading"})
    try:
        await asyncio.get_running_loop().run_in_executor(None, ENGINE.load)
        return True
    except Exception as e:
        if session:
            await session.send_json({"type": "error", "message": "The speech engine could not start: %s" % e})
        return False


async def ws_handler(request):
    ws = web.WebSocketResponse(max_msg_size=4 * 1024 * 1024, heartbeat=20)
    await ws.prepare(request)
    s = Session(ws)
    q = request.query
    if q.get("user"):
        s.user = q["user"]
        s.set_voice(q.get("voice"), q.get("speed"))
    SESSIONS.add(s)
    worker = asyncio.ensure_future(s.tts_worker())
    log("session opened (%d open)" % len(SESSIONS))
    try:
        async for msg in ws:
            if msg.type == WSMsgType.BINARY:
                s.feed(msg.data)
            elif msg.type == WSMsgType.TEXT:
                try:
                    m = json.loads(msg.data)
                except ValueError:
                    continue
                kind = m.get("type")
                if kind == "start":
                    s.configure(m)
                    log("session voice %s, speed %.2f, pause %d ms%s" % (s.voice, s.speed, s.endpoint_ms, " (saved for %s)" % s.user if s.user else ""))
                    if await ensure_loaded(s):
                        await s.send_json({"type": "status", "stage": "ready", "device": ENGINE.device})
                elif kind == "config":
                    s.configure(m)
                elif kind == "speak":
                    s.speak(int(m.get("id", 0)), str(m.get("text", "")), m.get("voice"), m.get("speed"))
                elif kind == "cancel":
                    s.cancel_speech()
                elif kind == "playing":
                    s.playing = bool(m.get("on"))
                elif kind == "mute":
                    s.muted = bool(m.get("on"))
                    if s.muted and s.speaking:
                        s.speaking = False
                        s.frames, s.probs = [], []
                        await s.send_json({"type": "discard", "utt": s.utt})
                elif kind == "flush" and s.speaking:
                    # "I'm done": the user tapped instead of waiting for the pause.
                    s._end_utterance()
            elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                break
    finally:
        s.closed = True
        s.cancel_speech()
        worker.cancel()
        SESSIONS.discard(s)
        ENGINE.last_used = time.monotonic()
        log("session closed (%d open)" % len(SESSIONS))
    return ws


async def health(_request):
    return web.json_response({
        "ok": True, "ready": ENGINE.ready, "loading": ENGINE.loading, "device": ENGINE.device,
        "error": ENGINE.error, "sessions": len(SESSIONS),
        # 2: sessions take the user's voice from the planner (/ws?user=, /session-prefs).
        "api": 2,
    })


async def session_prefs(request):
    """A user's saved voice changed (any device): their open sessions follow."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    n = 0
    for s in list(SESSIONS):
        if s.user and s.user == body.get("user"):
            s.set_voice(body.get("voice"), body.get("speed"))
            n += 1
    return web.json_response({"ok": True, "sessions": n})


async def voices(_request):
    return web.json_response({"voices": VOICES, "default": DEFAULT_VOICE})


async def preview(request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    voice = body.get("voice") if body.get("voice") in VOICE_IDS else DEFAULT_VOICE
    try:
        speed = min(1.5, max(0.7, float(body.get("speed", 1.0))))
    except (TypeError, ValueError):
        speed = 1.0
    text = clean_for_speech(str(body.get("text") or "Hi, I'm your planning assistant. What should we plan today?"))[:400]
    if not await ensure_loaded():
        return web.json_response({"error": ENGINE.error or "The speech engine could not start."}, status=503)
    pcm = await asyncio.get_running_loop().run_in_executor(ENGINE.tts_pool, ENGINE.speak, text, voice, speed)
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(TTS_RATE)
        w.writeframes(pcm.tobytes())
    return web.Response(body=out.getvalue(), content_type="audio/wav")


async def warm(_request):
    ok = await ensure_loaded()
    return web.json_response({"ok": ok, "ready": ENGINE.ready, "error": ENGINE.error})


async def idle_unloader(_app):
    async def loop():
        while True:
            await asyncio.sleep(60)
            if not SESSIONS and ENGINE.ready and time.monotonic() - ENGINE.last_used > IDLE_UNLOAD_S:
                await asyncio.get_running_loop().run_in_executor(None, ENGINE.unload)
    task = asyncio.ensure_future(loop())
    yield
    task.cancel()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5179)
    args = ap.parse_args()
    app = web.Application(client_max_size=1024 * 1024)
    app.router.add_get("/health", health)
    app.router.add_get("/voices", voices)
    app.router.add_post("/preview", preview)
    app.router.add_post("/warm", warm)
    app.router.add_post("/session-prefs", session_prefs)
    app.router.add_get("/ws", ws_handler)
    app.cleanup_ctx.append(idle_unloader)
    log("speech server on 127.0.0.1:%d" % args.port)
    web.run_app(app, host="127.0.0.1", port=args.port, print=None, handle_signals=True)


if __name__ == "__main__":
    main()
