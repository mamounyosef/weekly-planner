"""End-to-end check of speech-server.py over its WebSocket, no browser needed.

Has the server speak a sentence, feeds that audio back in as if it were the
microphone (in real time, 32 ms frames, then silence), and prints what it
heard and how long each step took.

    .venv-speech\\Scripts\\python.exe tools\\test-speech-server.py [--port 5179] [--text "..."]
"""

import argparse
import asyncio
import json
import struct
import time

import numpy as np
from aiohttp import ClientSession, WSMsgType


async def main(port, text, voice):
    async with ClientSession() as http:
        async with http.ws_connect("http://127.0.0.1:%d/ws" % port, max_msg_size=8 * 1024 * 1024) as ws:
            t0 = time.time()
            await ws.send_str(json.dumps({"type": "start", "voice": voice, "speed": 1.0, "endpointMs": 700}))
            while True:
                m = await ws.receive()
                if m.type == WSMsgType.TEXT:
                    d = json.loads(m.data)
                    print("%.2fs" % (time.time() - t0), d)
                    if d.get("stage") == "ready":
                        break
                    if d.get("type") == "error":
                        return
            # 1. Speak.
            t1 = time.time()
            await ws.send_str(json.dumps({"type": "speak", "id": 7, "text": text}))
            chunks, first = [], None
            while True:
                m = await ws.receive()
                if m.type == WSMsgType.BINARY:
                    if first is None:
                        first = time.time() - t1
                    sid = struct.unpack("<I", m.data[:4])[0]
                    assert sid == 7, sid
                    chunks.append(np.frombuffer(m.data[4:], dtype=np.int16))
                elif m.type == WSMsgType.TEXT:
                    d = json.loads(m.data)
                    if d.get("type") == "tts_done":
                        break
            pcm = np.concatenate(chunks)
            print("speak: first audio after %.2fs, %.2fs of speech" % (first, len(pcm) / 24000))
            # 2. Hear it back: 24 kHz -> 16 kHz, real-time frames, then 1.5 s of silence.
            f = pcm.astype(np.float32)
            mic = np.interp(np.arange(0, len(f), 1.5), np.arange(len(f)), f).astype(np.int16)
            mic = np.concatenate([np.zeros(8000, np.int16), mic, np.zeros(24000, np.int16)])

            async def reader():
                end_at = None
                async for m in ws:
                    if m.type != WSMsgType.TEXT:
                        continue
                    d = json.loads(m.data)
                    now = time.time()
                    print("%.2fs" % (now - t2), d)
                    if d.get("type") in ("final", "discard"):
                        return

            t2 = time.time()
            task = asyncio.ensure_future(reader())
            for i in range(0, len(mic), 512):
                await ws.send_bytes(mic[i:i + 512].tobytes())
                # Paced against the clock, not by summed sleeps: Windows timers
                # are coarse and the stream would drift slower than real time.
                await asyncio.sleep(max(0, t2 + (i + 512) / 16000 - time.time()))
                if task.done():
                    break
            await asyncio.wait_for(task, 10)
            speech_end = (len(mic) - 24000) / 16000
            print("speech ended at %.2fs into the stream" % speech_end)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5179)
    ap.add_argument("--voice", default="af_heart")
    ap.add_argument("--text", default="Can you move my gym session on Thursday to six in the evening, and add a reminder?")
    a = ap.parse_args()
    asyncio.run(main(a.port, a.text, a.voice))
