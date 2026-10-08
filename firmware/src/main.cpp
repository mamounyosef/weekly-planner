// ---------------------------------------------------------------------------
// Daily Planner -- focus timer hardware controller (ESP32-S3).
//
// This firmware is deliberately dumb. It reports what the sensor and buttons
// see, renders whatever the server tells it to, and holds no opinion about
// what a focus session is. Every decision -- when a session starts, whether a
// short one is saved, what the 30-second arming window does -- belongs to the
// app, which already implements all of it. Keeping that logic in one place is
// the whole point: the hardware buttons and the on-screen buttons must never
// be able to disagree.
//
// TWO TASKS. All networking runs in its own FreeRTOS task on core 0; the
// display, LEDs, sensor and buttons run in loop() on core 1. They used to share
// one loop, so every HTTP request blocked the screen: a single slow connect
// (up to 5s each, several requests per cycle) froze the clock mid-second and
// then tripped "No connection" while the server was perfectly fine. Now the
// network can stall for as long as it likes and the display keeps ticking.
//
// Tunables live in config.h; WiFi and server address in secrets.h.
// ---------------------------------------------------------------------------

#include <Arduino.h>
#include <ArduinoOTA.h>
#include <ESPmDNS.h>
#include <HTTPClient.h>
#include <LiquidCrystal_I2C.h>
#include <Preferences.h>
#include <WiFi.h>
#include <Wire.h>
#include <esp_task_wdt.h>

#include "config.h"
#include "secrets.h"

// ---------------------------------------------------------------------------
// Shared state between the UI loop (core 1) and the network task (core 0).
// Everything below marked "locked" is only touched while holding gLock.
// ---------------------------------------------------------------------------

static SemaphoreHandle_t gLock = nullptr;

struct Locked {
  Locked() { xSemaphoreTake(gLock, portMAX_DELAY); }
  ~Locked() { xSemaphoreGive(gLock); }
};

// Set while an OTA upload is running: the network task goes quiet so the
// upload has the radio to itself.
static volatile bool otaActive = false;

// When the network task last went round its loop. The UI loop restarts the
// board if this stops moving, since a task wedged inside the IP stack can
// never recover on its own.
static volatile unsigned long netAliveAt = 0;

// Set once the network task has started the mDNS responder.
static volatile bool mdnsReady = false;

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

// Counts every edge each button pin sees, accepted or not. Sampling the level
// from the main loop kept missing the press; a counter cannot, whenever the
// button happens to be pressed. Declared here so the live stream can report
// them alongside the sensor reading.
static volatile unsigned long btnAEdges = 0;
static volatile unsigned long btnBEdges = 0;

// Most PCF8574 backpacks are 0x27, some are 0x3F. Detected at boot.
static uint8_t lcdAddr = 0x27;
static LiquidCrystal_I2C *lcd = nullptr;

// The LCD is slow (~40ms for a full repaint) and redrawing identical text makes
// it visibly flicker, so each line is only pushed when it actually changes.
// Only ever touched from core 1 (loop and the OTA callbacks, which run in it).
static String lcdLine0Shown = "";
static String lcdLine1Shown = "";
static bool lcdNeedsResync = false;

// ---------------------------------------------------------------------------
// LCD Hardware Recovery & Auto-Healing
// ---------------------------------------------------------------------------
// The HD44780 LCD controller operates in 4-bit mode over the PCF8574 I2C
// expander. In 4-bit mode, every byte is split into two nibbles. If an electrical
// noise pulse (e.g. from WiFi TX bursts, ultrasonic transducer pings, or static)
// glitches an Enable strobe, the HD44780's internal nibble state machine becomes
// desynchronized (high and low nibbles inverted). Subsequent writes are
// misinterpreted as arbitrary commands, corrupting DDRAM, entry mode, or CGRAM
// (producing scrambled/garbled characters and broken blocks on screen).
//
// Because the HD44780 is write-only in this configuration, it cannot report its
// corrupted state. The only way to recover WITHOUT power-cycling the board is the
// official Hitachi HD44780 hardware reset sequence: pulsing 0x03 three times to
// force it back to 8-bit mode, then pulsing 0x02 to switch to 4-bit mode.
static void lcdHardwareResync() {
  if (!lcd) return;

  Wire.setTimeOut(50);

  // Helper to send a raw 4-bit nibble with Enable pulse directly via PCF8574
  auto pulseRawNibble = [](uint8_t nibble4bit) {
    uint8_t val = (nibble4bit << 4) | 0x08; // Backlight ON (bit 3), RS=0 (command), RW=0
    Wire.beginTransmission(lcdAddr);
    Wire.write(val);
    Wire.endTransmission();

    Wire.beginTransmission(lcdAddr);
    Wire.write(val | 0x04); // EN = 1
    Wire.endTransmission();
    delayMicroseconds(2);

    Wire.beginTransmission(lcdAddr);
    Wire.write(val & ~0x04); // EN = 0
    Wire.endTransmission();
    delayMicroseconds(50);
  };

  // Step 1: Force HD44780 into 8-bit mode (3x 0x03 pulses with delays per datasheet)
  pulseRawNibble(0x03);
  delayMicroseconds(4500); // > 4.1ms

  pulseRawNibble(0x03);
  delayMicroseconds(4500); // > 4.1ms

  pulseRawNibble(0x03);
  delayMicroseconds(200);  // > 100us

  // Step 2: Switch to 4-bit interface (nibble phase is now 100% aligned to high nibble)
  pulseRawNibble(0x02);
  delayMicroseconds(200);

  // Step 3: Re-apply essential LCD configuration registers without blanking the screen
  // (Using Return Home 0x02 instead of Clear 0x01 ensures zero visible flicker).
  lcd->command(0x28); // Function Set: 4-bit mode, 2 lines, 5x8 font
  delayMicroseconds(50);
  lcd->command(0x0C); // Display ON, Cursor OFF, Blink OFF
  delayMicroseconds(50);
  lcd->command(0x06); // Entry Mode Set: increment cursor, no display shift
  delayMicroseconds(50);
  lcd->command(0x02); // Return Home: resets address counter without blanking DDRAM
  delayMicroseconds(2000); // Return Home requires > 1.52ms
  lcd->backlight();

  // Clear line caches to force an in-place overwrite of all 32 character cells
  lcdLine0Shown = "";
  lcdLine1Shown = "";
  lcdNeedsResync = false;
}

static void lcdShow(uint8_t row, const String &text) {
  if (!lcd) return;

  String padded = text;
  while (padded.length() < 16) padded += ' ';
  padded = padded.substring(0, 16);

  String &cache = row == 0 ? lcdLine0Shown : lcdLine1Shown;
  if (cache == padded) return;

  // Repainting the whole line every second blanks and redraws all 16 cells,
  // which reads as a flicker. Only the runs of characters that actually differ
  // are pushed, reducing I2C bus traffic.
  const bool sameLength = cache.length() == padded.length();
  int i = 0;
  while (i < 16) {
    const bool differs = !sameLength || cache[i] != padded[i];
    if (!differs) {
      i++;
      continue;
    }
    int runStart = i;
    while (i < 16 && (!sameLength || cache[i] != padded[i])) i++;
    lcd->setCursor(runStart, row);
    for (int j = runStart; j < i; j++) lcd->write(padded[j]);
  }

  cache = padded;
}

// ---------------------------------------------------------------------------
// Status LED
// ---------------------------------------------------------------------------

enum LedState { LED_OFFLINE, LED_RUNNING, LED_IDLE, LED_ARMING };

// Plain GPIO LEDs, unlike the onboard WS2812 -- no timing constraints, but
// still only written on change to keep the loop free of pointless work.
static void externalLeds(bool running) {
  static int lastRunning = -1;
  if (lastRunning == static_cast<int>(running)) return;
  lastRunning = static_cast<int>(running);

  digitalWrite(PIN_LED_GREEN, running ? HIGH : LOW);
  digitalWrite(PIN_LED_YELLOW, running ? LOW : HIGH);
}

// neopixelWrite() bit-bangs the WS2812 with interrupts disabled, which is long
// enough to corrupt an I2C transfer that is in flight to the LCD. Calling it
// every loop iteration therefore shows up as garbage characters on the display,
// so the colour is only pushed when it actually changes.
static void ledApply(LedState state, bool blinkPhase) {
  static int lastKey = -1;
  const int key = static_cast<int>(state) * 2 + (state == LED_ARMING && blinkPhase ? 1 : 0);
  if (key == lastKey) return;
  lastKey = key;

  const uint8_t b = LED_BRIGHTNESS;
  switch (state) {
    case LED_OFFLINE:  // yellow -- no WiFi, or the app/server is unreachable
      neopixelWrite(PIN_LED, b, b * 3 / 4, 0);
      break;
    case LED_RUNNING:  // blue -- a focus session is running
      neopixelWrite(PIN_LED, 0, b / 4, b);
      break;
    case LED_ARMING:  // blinking blue -- sitting detected, session about to start
      if (blinkPhase) neopixelWrite(PIN_LED, 0, b / 4, b);
      else neopixelWrite(PIN_LED, 0, 0, 0);
      break;
    case LED_IDLE:  // red -- connected, but nothing running
      neopixelWrite(PIN_LED, b, 0, 0);
      break;
  }
}

// ---------------------------------------------------------------------------
// Ultrasonic sensor
// ---------------------------------------------------------------------------

// One HC-SR04 ping. Returns the raw distance in cm, or 0 when nothing echoed
// back within the timeout.
//
// Nothing is filtered, clamped or interpreted here. A reading of 400 might be
// an empty room or a foot resting against the transducer, and 6 cm might be a
// hand or the module ringing -- telling those apart needs several seconds of
// context and a good deal of arithmetic, which is the app's job (see
// src/lib/sensorFilter.ts). The board's only responsibility is to report
// honestly and often.
static float pingOnce() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(3);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);

  unsigned long us = pulseIn(PIN_ECHO, HIGH, 30000UL);
  if (us == 0) return 0.0f;  // no echo -- a real observation, not a failure
  return us / 58.0f;
}

// The one number the board still needs of its own: how often to ping. Replaced
// by whatever the app's settings say; the value here is only what gets used in
// the seconds before the first config fetch succeeds. Written by the network
// task, read by the loop; a 32-bit store is atomic on this core.
static volatile long sampleIntervalMs = SAMPLE_INTERVAL_MS;

// Raw pings waiting to be posted (locked). If the server is unreachable for a
// while the oldest are dropped rather than the newest: the filter only cares
// about the recent past, and a backlog would arrive with reconstructed
// timestamps that no longer describe anything.
static float sampleBatch[SAMPLE_BATCH_MAX];
static int sampleBatchCount = 0;

static void pushSample(float cm) {
  Locked l;
  if (sampleBatchCount >= SAMPLE_BATCH_MAX) {
    memmove(sampleBatch, sampleBatch + 1, sizeof(float) * (SAMPLE_BATCH_MAX - 1));
    sampleBatchCount = SAMPLE_BATCH_MAX - 1;
  }
  sampleBatch[sampleBatchCount++] = cm;
}

// ---------------------------------------------------------------------------
// What the display shows (locked)
// ---------------------------------------------------------------------------

// Everything the display needs, as last reported by the server. Plain chars
// rather than String so a copy taken under the lock never touches the heap.
struct UiState {
  char mode[12] = "idle";  // idle | arming | running | paused | offline
  long remainingSeconds = 0;
  long todaySeconds = 0;
  long sessionsToday = 0;
  long armSeconds = 0;
  bool valid = false;
  unsigned long receivedAt = 0;  // millis() when these numbers arrived
};
static UiState ui;
static unsigned long lastServerOkAt = 0;

// Diagnostics, reported back to the server with every batch.
static String resolvedHost = "";
static int lastPollCode = 0;
static unsigned long netFails = 0;
static unsigned long wifiReconnects = 0;
static unsigned long lastRttMs = 0;
static unsigned long netConnects = 0;  // new TCP connections; should barely move

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

// Active-LOW via INPUT_PULLUP, captured by interrupt rather than polled.
//
// Polling cannot catch a quick tap here: pulseIn() blocks for up to 30ms per
// sensor reading, so a press that begins and ends between two digitalRead()
// calls is simply never seen. An interrupt latches the press the instant it
// happens, whatever the main loop is busy with, and the loop drains the latch
// when it gets around to it. Presses are identified by how long the line is
// actually held down, measured entirely inside the interrupt.
//
// The buttons here run on long parallel wires with only the weak internal
// pull-up holding them high, so pressing one couples a spike into the other:
// every press of A produced a phantom B about 80ms later, which terminated the
// session. A finger holds a line down for tens of milliseconds; induced
// coupling lasts microseconds. Timing the pulse tells them apart with no
// ambiguity and no extra hardware.
static const unsigned long BTN_MIN_PRESS_US = 15000;   // 15ms: far longer than any spike
static const unsigned long BTN_MAX_PRESS_US = 5000000; // 5s: beyond this it is stuck, not pressed
static const unsigned long BTN_CROSS_LOCKOUT_MS = 250;

static volatile bool btnAPressed = false;
static volatile bool btnBPressed = false;
static volatile unsigned long btnAFellAt = 0;
static volatile unsigned long btnBFellAt = 0;
static volatile unsigned long btnARejectedUs = 0;  // width of the last spike, for diagnosis
static volatile unsigned long btnBRejectedUs = 0;

// Raw trace of the last few edges, so a button that produces neither a press
// nor a rejection can be diagnosed without a cable.
struct EdgeTrace { unsigned long us; int pin; int level; unsigned long width; };
static volatile EdgeTrace edgeTrace[12];
static volatile int edgeTraceHead = 0;
static volatile int edgeTracePending = 0;
static portMUX_TYPE edgeMux = portMUX_INITIALIZER_UNLOCKED;

static void IRAM_ATTR traceEdge(int pin, int level, unsigned long us, unsigned long width) {
  portENTER_CRITICAL_ISR(&edgeMux);
  const int i = edgeTraceHead;
  edgeTrace[i].us = us;
  edgeTrace[i].pin = pin;
  edgeTrace[i].level = level;
  edgeTrace[i].width = width;
  edgeTraceHead = (i + 1) % 12;
  if (edgeTracePending < 12) edgeTracePending++;
  portEXIT_CRITICAL_ISR(&edgeMux);
}

static void IRAM_ATTR onBtnEdge(int pin, volatile unsigned long &fellAt,
                                volatile bool &pressed, volatile unsigned long &rejectedUs) {
  const unsigned long us = micros();
  if (pin == PIN_BTN_A) btnAEdges++; else btnBEdges++;
  traceEdge(pin, digitalRead(pin), us, fellAt ? us - fellAt : 0);
  if (digitalRead(pin) == LOW) {
    if (fellAt == 0) fellAt = us;   // press begins; a re-trigger mid-press is bounce
    return;
  }
  if (fellAt == 0) return;          // a rising edge with no matching fall
  const unsigned long width = us - fellAt;
  fellAt = 0;
  if (width >= BTN_MIN_PRESS_US && width <= BTN_MAX_PRESS_US) pressed = true;
  else rejectedUs = width;          // too brief to be a finger
}

static void IRAM_ATTR onBtnA() { onBtnEdge(PIN_BTN_A, btnAFellAt, btnAPressed, btnARejectedUs); }
static void IRAM_ATTR onBtnB() { onBtnEdge(PIN_BTN_B, btnBFellAt, btnBPressed, btnBRejectedUs); }

// Accepted presses waiting to reach the server (locked). A press is retried
// until the server acknowledges it, and carries a sequence number so a retry
// whose first attempt did get through is not counted twice. One that cannot be
// delivered within BUTTON_RETRY_MS is dropped: acting on it later would start
// or stop a session at a moment nobody chose.
struct PendingPress { uint32_t seq; uint8_t isB; unsigned long at; };
static PendingPress pressQueue[8];
static int pressCount = 0;
static uint32_t pressSeq = 0;
static char bootId[9] = "";

// Rejected pulses waiting to be logged (locked), same reasoning: the board has
// no cable attached, so the app's log is the only place these can be seen.
struct Rejection { uint8_t isB; unsigned long widthUs; };
static Rejection rejectQueue[4];
static int rejectCount = 0;

static unsigned long lastAcceptedAt = 0;
static int lastAcceptedPin = -1;

static void acceptButton(int pin, unsigned long now) {
  const bool isB = pin == PIN_BTN_B;
  // Belt and braces on top of the pulse-width test: two different buttons a
  // fraction of a second apart is not something a hand does.
  if (lastAcceptedPin != -1 && lastAcceptedPin != pin && now - lastAcceptedAt < BTN_CROSS_LOCKOUT_MS) {
    Serial.printf("[btn] %s rejected: %lums after the other button\n", isB ? "B" : "A", now - lastAcceptedAt);
    return;
  }
  lastAcceptedAt = now;
  lastAcceptedPin = pin;
  Serial.printf("[btn] %s\n", isB ? "B" : "A");
  Locked l;
  if (pressCount >= 8) {
    memmove(pressQueue, pressQueue + 1, sizeof(PendingPress) * 7);
    pressCount = 7;
  }
  pressQueue[pressCount++] = { ++pressSeq, static_cast<uint8_t>(isB ? 1 : 0), now };
}

static void queueRejection(bool isB, unsigned long widthUs) {
  Serial.printf("[btn] %s rejected: %luus pulse\n", isB ? "B" : "A", widthUs);
  Locked l;
  if (rejectCount < 4) rejectQueue[rejectCount++] = { static_cast<uint8_t>(isB ? 1 : 0), widthUs };
}

static void drainButtons(unsigned long now) {
  if (btnAPressed) { btnAPressed = false; acceptButton(PIN_BTN_A, now); }
  if (btnBPressed) { btnBPressed = false; acceptButton(PIN_BTN_B, now); }
  if (btnARejectedUs) { const unsigned long w = btnARejectedUs; btnARejectedUs = 0; queueRejection(false, w); }
  if (btnBRejectedUs) { const unsigned long w = btnBRejectedUs; btnBRejectedUs = 0; queueRejection(true, w); }
}

// ---------------------------------------------------------------------------
// Server link (network task only, except where noted)
// ---------------------------------------------------------------------------

// Where the server is. Tried in order whenever the current one stops
// answering: a fresh mDNS lookup, the last address that actually worked
// (kept across reboots), then the compiled-in fallback. The fallback alone is
// not enough -- the PC's DHCP address changes, and a stale fallback used to
// strand the board until the next lucky mDNS answer.
static Preferences prefs;
static String lastGoodHost = "";
static int hostCandidate = 0;  // 0 = mDNS, 1 = last good, 2 = compiled-in

static String mdnsLookup() {
  IPAddress ip = MDNS.queryHost(SERVER_MDNS, MDNS_TIMEOUT_MS);
  // A resolved address is only accepted if it is actually plausible. A
  // resolver answering with something off-network would otherwise be latched
  // in permanently.
  const IPAddress me = WiFi.localIP();
  if (ip != IPAddress((uint32_t)0) && ip[0] == me[0] && ip[1] == me[1] && ip[2] == me[2]) return ip.toString();
  return "";
}

static void chooseHost() {
  String next = "";
  for (int tries = 0; tries < 3 && next.isEmpty(); tries++) {
    const int c = hostCandidate;
    hostCandidate = (hostCandidate + 1) % 3;
    if (c == 0) next = mdnsLookup();
    else if (c == 1) next = lastGoodHost;
    else next = SERVER_HOST;
    Serial.printf("[host] candidate %d -> %s\n", c, next.length() ? next.c_str() : "(none)");
  }
  if (next.isEmpty()) next = SERVER_HOST;
  Locked l;
  resolvedHost = next;
}

static void rememberGoodHost(const String &host) {
  if (host == lastGoodHost) return;
  lastGoodHost = host;
  prefs.putString("host", host);
  Serial.printf("[host] remembered %s\n", host.c_str());
}

// One persistent keep-alive connection for everything. Opening a fresh TCP
// connection per request (five a second) was the old design; each one was a
// chance for a lost SYN to cost a multi-second retransmit, and every one of
// those stalls landed on the display.
static WiFiClient netClient;
static HTTPClient http;
static String connectedHost = "";

// Returns the HTTP status, or a negative HTTPClient error. `out` receives the
// body. The body is always read in full: bytes left unread on a reused
// connection would be taken as the start of the next response.
static int request(const char *method, const char *path, const String &body, String *out) {
  String host;
  {
    Locked l;
    host = resolvedHost;
  }
  if (host != connectedHost) {
    netClient.stop();
    connectedHost = host;
  }

  // A reused connection the server has just closed fails instantly, which is
  // not an outage; one retry on a fresh connection tells the two apart.
  for (int attempt = 0; attempt < 2; attempt++) {
    const bool reused = netClient.connected();
    if (!reused) netConnects++;
    // HTTPClient writes a POST's headers and body separately. With Nagle on,
    // the body waits for the PC to ACK the headers, and Windows delays that
    // ACK, which added ~50ms to every batch. Only settable on a live socket,
    // so a fresh connection gets it from its second request on.
    else netClient.setNoDelay(true);
    const unsigned long t0 = millis();
    if (!http.begin(netClient, String("http://") + host + ":" + String(SERVER_PORT) + path)) return -1;
    http.setReuse(true);
    http.setConnectTimeout(HTTP_CONNECT_TIMEOUT_MS);
    http.setTimeout(HTTP_TIMEOUT_MS);
    int code;
    if (strcmp(method, "POST") == 0) {
      http.addHeader("Content-Type", "application/json");
      code = http.POST(body);
    } else {
      code = http.GET();
    }
    if (code > 0) {
      String text = http.getString();
      if (out) *out = text;
      http.end();
      lastRttMs = millis() - t0;
      return code;
    }
    http.end();
    netClient.stop();
    if (!reused) return code;
  }
  return -1;
}

// Minimal field extraction. A JSON library would be overkill for a flat object
// of a few known keys that we generate ourselves on the server side.
static bool jsonNumber(const String &src, const char *key, long &out) {
  String needle = String("\"") + key + "\":";
  int at = src.indexOf(needle);
  if (at < 0) return false;
  at += needle.length();
  while (at < (int)src.length() && src[at] == ' ') at++;
  int end = at;
  if (end < (int)src.length() && (src[end] == '-' || src[end] == '+')) end++;
  while (end < (int)src.length() && (isdigit(src[end]) || src[end] == '.')) end++;
  if (end == at) return false;
  out = src.substring(at, end).toInt();
  return true;
}

static bool jsonString(const String &src, const char *key, String &out) {
  String needle = String("\"") + key + "\":\"";
  int at = src.indexOf(needle);
  if (at < 0) return false;
  at += needle.length();
  int end = src.indexOf('"', at);
  if (end < 0) return false;
  out = src.substring(at, end);
  return true;
}

// Every number on this display is computed by the app and read verbatim. The
// firmware does no arithmetic on the totals of its own; the only thing it
// does locally is keep a running clock moving for a few seconds if an update
// is late (see renderLcd), and the next update overwrites that.
static bool applyState(const String &body) {
  String mode;
  if (!jsonString(body, "mode", mode)) return false;
  UiState next;
  strlcpy(next.mode, mode.c_str(), sizeof(next.mode));
  jsonNumber(body, "remainingSeconds", next.remainingSeconds);
  jsonNumber(body, "todaySeconds", next.todaySeconds);
  jsonNumber(body, "sessionsToday", next.sessionsToday);
  jsonNumber(body, "armSeconds", next.armSeconds);
  next.valid = true;
  next.receivedAt = millis();
  Locked l;
  ui = next;
  lastServerOkAt = next.receivedAt;
  return true;
}

static void noteResult(int code) {
  static int consecutiveFailures = 0;
  {
    Locked l;
    lastPollCode = code;
  }
  if (code > 0 && code < 500) {
    consecutiveFailures = 0;
    String host;
    {
      Locked l;
      host = resolvedHost;
    }
    rememberGoodHost(host);
    return;
  }
  netFails++;
  Serial.printf("[net] request failed: %d\n", code);
  // Repeated failures mean the address may be wrong, not just that the server
  // is busy. Move on to the next candidate rather than retrying a dead one.
  if (++consecutiveFailures >= FAILURES_BEFORE_RERESOLVE) {
    consecutiveFailures = 0;
    chooseHost();
  }
}

// Ships the pings collected since the last batch, and takes the display state
// back on the same response.
//
// `dt` rather than timestamps: the board's millis() and the PC's clock share no
// epoch, and millis() restarts on every reset, so the server reconstructs the
// sample times backwards from the moment the batch arrived instead.
static void postSamples() {
  float local[SAMPLE_BATCH_MAX];
  int n;
  String host;
  UiState shown;
  int pollCode;
  {
    Locked l;
    n = sampleBatchCount;
    memcpy(local, sampleBatch, sizeof(float) * n);
    sampleBatchCount = 0;
    host = resolvedHost;
    shown = ui;
    pollCode = lastPollCode;
  }

  String cmList = "[";
  for (int i = 0; i < n; i++) {
    if (i) cmList += ",";
    cmList += String(local[i], 1);
  }
  cmList += "]";

  // Raw button levels ride along: a button that produces no events at all is
  // otherwise indistinguishable from one that is never pressed, and the board
  // has no cable attached to check with. Link health rides along too, so a
  // "No connection" can be diagnosed from the app's side after the fact.
  const String json = String("{\"type\":\"samples\",\"dt\":") + String(sampleIntervalMs) +
                      ",\"cm\":" + cmList +
                      ",\"btnA\":" + String(digitalRead(PIN_BTN_A)) +
                      ",\"btnB\":" + String(digitalRead(PIN_BTN_B)) +
                      ",\"edgesA\":" + String(btnAEdges) +
                      ",\"edgesB\":" + String(btnBEdges) +
                      ",\"host\":\"" + host + "\"" +
                      ",\"pollCode\":" + String(pollCode) +
                      ",\"uiMode\":\"" + shown.mode + "\"" +
                      ",\"uiValid\":" + (shown.valid ? "true" : "false") +
                      ",\"rssi\":" + String(WiFi.RSSI()) +
                      ",\"uptimeS\":" + String(millis() / 1000) +
                      ",\"netFails\":" + String(netFails) +
                      ",\"wifiReconnects\":" + String(wifiReconnects) +
                      ",\"freeHeap\":" + String(ESP.getFreeHeap()) +
                      ",\"rttMs\":" + String(lastRttMs) +
                      ",\"conns\":" + String(netConnects) +
                      ",\"resetReason\":" + String(static_cast<int>(esp_reset_reason())) + "}";

  String reply;
  const int code = request("POST", "/api/hardware/event", json, &reply);
  noteResult(code);
  if (code != 200) return;

  // A server too old to send the state back is asked for it separately.
  if (!applyState(reply)) {
    String state;
    const int c2 = request("GET", "/api/hardware/state", "", &state);
    if (c2 == 200) applyState(state);
  }
}

static void sendPresses() {
  for (;;) {
    PendingPress p;
    {
      Locked l;
      // Drop presses too old to act on.
      while (pressCount > 0 && millis() - pressQueue[0].at > BUTTON_RETRY_MS) {
        Serial.printf("[btn] press %u expired undelivered\n", pressQueue[0].seq);
        memmove(pressQueue, pressQueue + 1, sizeof(PendingPress) * (pressCount - 1));
        pressCount--;
      }
      if (pressCount == 0) return;
      p = pressQueue[0];
    }
    const String json = String("{\"type\":\"") + (p.isB ? "button_b" : "button_a") +
                        "\",\"boot\":\"" + bootId + "\",\"seq\":" + String(p.seq) + "}";
    const int code = request("POST", "/api/hardware/event", json, nullptr);
    Serial.printf("[event] %s -> %d\n", json.c_str(), code);
    noteResult(code);
    // 4xx means the server understood and refused; retrying cannot change that.
    if (code <= 0 || code >= 500) return;  // retried next pass
    Locked l;
    if (pressCount > 0 && pressQueue[0].seq == p.seq) {
      memmove(pressQueue, pressQueue + 1, sizeof(PendingPress) * (pressCount - 1));
      pressCount--;
    }
  }
}

// Diagnostic log lines: at most one per pass, and only after the real traffic,
// so a burst of electrical noise on the buttons can never delay the display.
static void sendOneLogLine() {
  Rejection r;
  bool haveReject = false;
  {
    Locked l;
    if (rejectCount > 0) {
      r = rejectQueue[0];
      memmove(rejectQueue, rejectQueue + 1, sizeof(Rejection) * (rejectCount - 1));
      rejectCount--;
      haveReject = true;
    }
  }
  if (haveReject) {
    request("POST", "/api/hardware/log",
            String("{\"source\":\"firmware\",\"rejected\":\"") + (r.isB ? "button_b" : "button_a") +
                "\",\"widthUs\":" + String(r.widthUs) + "}",
            nullptr);
    return;
  }

  EdgeTrace e;
  portENTER_CRITICAL(&edgeMux);
  const bool haveEdge = edgeTracePending > 0;
  if (haveEdge) {
    const int idx = (edgeTraceHead - edgeTracePending + 12) % 12;
    e = { edgeTrace[idx].us, edgeTrace[idx].pin, edgeTrace[idx].level, edgeTrace[idx].width };
    edgeTracePending--;
  }
  portEXIT_CRITICAL(&edgeMux);
  if (haveEdge) {
    request("POST", "/api/hardware/log",
            String("{\"source\":\"edge\",\"pin\":") + e.pin + ",\"level\":" + e.level +
                ",\"us\":" + e.us + ",\"width\":" + e.width + "}",
            nullptr);
  }
}

// Pulls the ping rate the app's settings page publishes. A failure just leaves
// the previous value in force.
static void pollConfig() {
  String body;
  if (request("GET", "/api/hardware/config", "", &body) != 200) return;
  long n = 0;
  if (jsonNumber(body, "sampleIntervalMs", n)) sampleIntervalMs = constrain(n, 40L, 2000L);
}

// Keeps the WiFi association alive. Auto-reconnect handles the common case,
// but the driver can sit "disconnected" indefinitely after some AP restarts,
// and can also report "connected" while nothing gets through. Both are
// handled here by starting the association over.
static void superviseWifi(unsigned long now) {
  static unsigned long downSince = 0;
  static unsigned long lastKick = 0;

  if (WiFi.status() == WL_CONNECTED) {
    if (downSince) {
      Serial.printf("[wifi] back, ip=%s rssi=%d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
      downSince = 0;
      if (!mdnsReady) mdnsReady = MDNS.begin("planner-desk");
      hostCandidate = 0;
      chooseHost();
    }
    // Connected, but the server has not answered for a long time: the
    // association itself may be dead. Rejoin, at most once per interval.
    unsigned long okAt;
    {
      Locked l;
      okAt = lastServerOkAt;
    }
    if (now - okAt > WIFI_REJOIN_SILENT_MS && now - lastKick > WIFI_REJOIN_SILENT_MS) {
      lastKick = now;
      wifiReconnects++;
      Serial.println("[wifi] connected but server silent, rejoining");
      netClient.stop();
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASS);
    }
    return;
  }

  if (!downSince) {
    downSince = now ? now : 1;
    netClient.stop();
    Serial.println("[wifi] lost");
  }
  if (now - downSince > WIFI_RESTART_MS && now - lastKick > WIFI_RESTART_MS) {
    lastKick = now;
    wifiReconnects++;
    Serial.println("[wifi] still down, restarting the association");
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }
}

static void netTask(void *) {
  // Join here rather than in setup(): the join can take many seconds, and the
  // display should be alive and saying so the whole time.
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // sleep adds seconds of latency to the poll
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("[wifi] joining %s\n", WIFI_SSID);

  unsigned long lastBatch = 0;
  unsigned long lastConfig = 0;
  for (;;) {
    const unsigned long now = millis();
    netAliveAt = now;

    if (otaActive) {
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }

    superviseWifi(now);
    if (WiFi.status() != WL_CONNECTED) {
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }

    // Presses first: they are the only thing a person is waiting on.
    sendPresses();

    if (now - lastBatch >= SAMPLE_BATCH_MS) {
      lastBatch = now;
      postSamples();
    }

    if (now - lastConfig >= CONFIG_POLL_INTERVAL_MS) {
      lastConfig = now;
      pollConfig();
    }

    sendOneLogLine();
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

static String mmss(long seconds) {
  if (seconds < 0) seconds = 0;
  long m = seconds / 60;
  long s = seconds % 60;
  char buf[16];
  snprintf(buf, sizeof(buf), "%02ld:%02ld", m, s);
  return String(buf);
}

// Matches the app's "Xh Ym" phrasing so the LCD and the on-screen total read
// the same way.
static String hoursMinutes(long seconds) {
  if (seconds < 0) seconds = 0;
  long h = seconds / 3600;
  long m = (seconds % 3600) / 60;
  char buf[16];
  if (h > 0) snprintf(buf, sizeof(buf), "%ldh %ldm", h, m);
  else snprintf(buf, sizeof(buf), "%ldm", m);
  return String(buf);
}

static void renderLcd(bool linkUp, const UiState &s, unsigned long now) {
  if (!linkUp) {
    lcdShow(0, "No connection");
    lcdShow(1, WiFi.status() == WL_CONNECTED ? "Server down" : "WiFi down");
    return;
  }

  // The server answers "offline" when it is up but no app window is driving the
  // controller -- which is the normal state for the first several seconds after
  // the PC boots, since the board is already running by then.
  if (strcmp(s.mode, "offline") == 0) {
    lcdShow(0, "Waiting for app");
    lcdShow(1, "Planner not open");
    return;
  }

  // A late update must not freeze a running clock. The numbers are the app's;
  // between updates the clock keeps moving at one second per second, for a
  // bounded time, and the next update replaces whatever it showed. Without
  // this, any hiccup on the network read as the display hanging.
  long ahead = now > s.receivedAt ? static_cast<long>((now - s.receivedAt) / 1000) : 0;
  if (ahead > MAX_EXTRAPOLATE_S) ahead = MAX_EXTRAPOLATE_S;

  long today = s.todaySeconds;
  if (strcmp(s.mode, "arming") == 0) {
    long arm = s.armSeconds - ahead;
    if (arm < 0) arm = 0;
    lcdShow(0, "Starting in " + String(arm) + "s");
  } else if (strcmp(s.mode, "running") == 0) {
    lcdShow(0, mmss(s.remainingSeconds - ahead));
    today += ahead;
  } else if (strcmp(s.mode, "paused") == 0) {
    lcdShow(0, mmss(s.remainingSeconds) + " PAUSED");
  } else {
    lcdShow(0, "Ready");
  }

  // Second line mirrors the widget's "Today 2h 30m - 3 done", squeezed to fit
  // 16 cells: the leading "Today" is dropped since the numbers speak for
  // themselves and the worst case ("12h 30m  10 done") is exactly 16.
  lcdShow(1, hoursMinutes(today) + "  " + String(s.sessionsToday) + " done");
}

// ---------------------------------------------------------------------------

// Over-the-air updates, so firmware changes no longer need the board carried
// to the PC and plugged in. The display says what is happening -- an update
// that appears to hang is otherwise indistinguishable from a crash.
//
// ArduinoOTA.handle() runs the whole upload inside loop(), so the watchdog is
// fed from the progress callback; otherwise every update would reboot the
// board halfway through.
static void setupOta() {
  ArduinoOTA.setHostname("planner-desk");
  ArduinoOTA.setPassword(OTA_PASSWORD);
  // mDNS is owned by the network task (it also does the server lookups), so
  // OTA only adds its service record instead of starting a second responder.
  ArduinoOTA.setMdnsEnabled(false);
  MDNS.enableArduino(3232, true);

  ArduinoOTA.onStart([]() {
    otaActive = true;
    lcdLine0Shown = "";  // force a full repaint over whatever was there
    lcdLine1Shown = "";
    lcdShow(0, "OTA update");
    lcdShow(1, "0%");
    Serial.println("[ota] start");
  });
  ArduinoOTA.onProgress([](unsigned int done, unsigned int total) {
    esp_task_wdt_reset();
    netAliveAt = millis();
    if (!total) return;
    lcdShow(1, String((done * 100) / total) + "%");
  });
  ArduinoOTA.onEnd([]() {
    lcdShow(0, "OTA done");
    lcdShow(1, "rebooting");
    Serial.println("[ota] done");
  });
  ArduinoOTA.onError([](ota_error_t err) {
    otaActive = false;
    lcdShow(0, "OTA failed");
    lcdShow(1, String("err ") + err);
    Serial.printf("[ota] error %u\n", err);
  });

  ArduinoOTA.begin();
  Serial.println("[ota] ready at planner-desk.local");
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== planner focus controller ===");

  gLock = xSemaphoreCreateMutex();
  snprintf(bootId, sizeof(bootId), "%08lx", static_cast<unsigned long>(esp_random()));

  ledApply(LED_OFFLINE, true);

  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_BTN_A, INPUT_PULLUP);
  pinMode(PIN_BTN_B, INPUT_PULLUP);
  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_LED_YELLOW, OUTPUT);
  digitalWrite(PIN_LED_GREEN, LOW);
  digitalWrite(PIN_LED_YELLOW, HIGH);  // nothing is running at boot
  // CHANGE, not FALLING: the press is identified by its width, which needs both
  // edges.
  attachInterrupt(digitalPinToInterrupt(PIN_BTN_A), onBtnA, CHANGE);
  attachInterrupt(digitalPinToInterrupt(PIN_BTN_B), onBtnB, CHANGE);

  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setTimeOut(50);
  // Left at the standard 100kHz: partial redraws cut the traffic enough that
  // the extra speed bought nothing, and the slower clock is more tolerant of
  // the level shifter and the run of jumper wire to the display.
  Wire.setClock(100000);
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      lcdAddr = addr;
      Serial.printf("[i2c] LCD at 0x%02X\n", addr);
      break;
    }
  }

  lcd = new LiquidCrystal_I2C(lcdAddr, 16, 2);
  lcdHardwareResync();

#if DIAG_NO_WIFI
  // Diagnostic mode: no radio, no LED, just a clock ticking on the display.
  WiFi.mode(WIFI_OFF);
  Serial.println("[diag] WiFi + LED disabled, free-running clock");
  strlcpy(ui.mode, "running", sizeof(ui.mode));
  ui.remainingSeconds = 3600;
  ui.todaySeconds = 9000;
  ui.valid = true;
  ui.receivedAt = millis();
  lastServerOkAt = millis();
#else
  lcdShow(0, "WiFi...");
  lcdShow(1, WIFI_SSID);

  prefs.begin("planner", false);
  lastGoodHost = prefs.getString("host", "");
  {
    Locked l;
    resolvedHost = lastGoodHost.length() ? lastGoodHost : String(SERVER_HOST);
  }
  // First candidate tried once the current one fails: a fresh mDNS lookup.
  hostCandidate = 0;

  netAliveAt = millis();
  // Core 0 is where the WiFi stack itself runs; loop() stays alone on core 1.
  // OTA is set up from loop() once the network task has the radio up.
  xTaskCreatePinnedToCore(netTask, "net", 8192, nullptr, 1, nullptr, 0);
#endif

  // A hung loop is worse than a reboot: the board would sit showing a frozen
  // clock forever. Generous timeout, since a wedged I2C bus can legitimately
  // make a redraw slow.
  esp_task_wdt_init(LOOP_WDT_TIMEOUT_S, true);
  esp_task_wdt_add(nullptr);
}

void loop() {
  unsigned long now = millis();
  esp_task_wdt_reset();

#if !DIAG_NO_WIFI
  // OTA starts once the network task has brought mDNS up, which is what lets
  // the board be found as planner-desk.local.
  static bool otaReady = false;
  if (!otaReady && mdnsReady) {
    setupOta();
    otaReady = true;
  }
  if (otaReady) ArduinoOTA.handle();

  // The network task has stopped going round: it is stuck inside the IP stack
  // and nothing short of a reboot will free it.
  if (!otaActive && now - netAliveAt > NET_TASK_STUCK_MS) {
    Serial.println("[net] task stuck, rebooting");
    delay(100);
    ESP.restart();
  }
#endif

  drainButtons(now);

  // --- LCD auto-healing & resilience ---
  // If an electrical spike / EMI glitches the 4-bit nibble state machine,
  // this self-healing cycle resets the HD44780 controller and rewrites the screen.
  static unsigned long lastLcdResync = 0;
  static unsigned long lastLcdForceRefresh = 0;

  if (lcdNeedsResync || (now - lastLcdResync >= LCD_RESYNC_INTERVAL_MS)) {
    lastLcdResync = now;
    lastLcdForceRefresh = now;
    lcdHardwareResync();
  } else if (now - lastLcdForceRefresh >= LCD_FORCE_REFRESH_MS) {
    // Periodic refresh: re-writes all 32 character cells to wipe away any single-character bit flips
    lastLcdForceRefresh = now;
    lcdLine0Shown = "";
    lcdLine1Shown = "";
  }

  // --- sensor ---
  // Ping and remember. The network task ships the batch.
  static unsigned long lastSample = 0;
  if (now - lastSample >= static_cast<unsigned long>(sampleIntervalMs)) {
    lastSample = now;
    pushSample(pingOnce());
  }

  // --- display + LED ---
  now = millis();
  UiState s;
  unsigned long okAt;
  {
    Locked l;
    s = ui;
    okAt = lastServerOkAt;
  }

  // Judged purely on how long it has been since the server was last reached,
  // so transient request failures ride through instead of flashing an error.
  // Unsigned subtraction, computed against a fresh millis(): the network task
  // can stamp okAt after `now` was taken, which must read as zero, not as an
  // enormous age.
  const unsigned long sinceOk = okAt > now ? 0 : now - okAt;
  const bool linkUp = s.valid && sinceOk < static_cast<unsigned long>(SERVER_STALE_MS);

  static bool lastLinkUp = true;
  if (linkUp != lastLinkUp) {
    lastLinkUp = linkUp;
    // Wipe line caches on state change so the new message is fully drawn
    lcdLine0Shown = "";
    lcdLine1Shown = "";
    Serial.printf("[link] %s (valid=%d wifi=%d sinceOk=%lums)\n", linkUp ? "UP" : "DOWN", s.valid ? 1 : 0,
                  WiFi.status() == WL_CONNECTED ? 1 : 0, sinceOk);
  }

  if (!otaActive) renderLcd(linkUp, s, now);

  // Green strictly tracks "a session is counting right now" -- arming does not
  // qualify, since nothing is being recorded yet.
  const bool running = strcmp(s.mode, "running") == 0;
  externalLeds(linkUp && running);

  LedState led;
  // An app that is not there yet is as good as no link as far as the status
  // light is concerned -- it must not sit on the calm idle colour as though
  // everything were up and simply quiet.
  if (!linkUp || strcmp(s.mode, "offline") == 0) led = LED_OFFLINE;
  else if (strcmp(s.mode, "arming") == 0) led = LED_ARMING;
  else if (running) led = LED_RUNNING;
  else led = LED_IDLE;
  ledApply(led, (now / 400) % 2 == 0);

  delay(5);
}
