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
// Tunables live in config.h; WiFi and server address in secrets.h.
// ---------------------------------------------------------------------------

#include <Arduino.h>
#include <ArduinoOTA.h>
#include <ESPmDNS.h>
#include <HTTPClient.h>
#include <LiquidCrystal_I2C.h>
#include <WiFi.h>
#include <Wire.h>

#include "config.h"
#include "secrets.h"

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
// the seconds before the first config fetch succeeds.
struct SensorConfig {
  long sampleIntervalMs = SAMPLE_INTERVAL_MS;
};
static SensorConfig cfg;

// Raw pings waiting to be posted. Sized well past what one batch interval can
// produce at the fastest allowed rate, so a slow or retried POST cannot make
// the board drop readings the filter is counting on.
static float sampleBatch[SAMPLE_BATCH_MAX];
static int sampleBatchCount = 0;

static void pushSample(float cm) {
  if (sampleBatchCount < SAMPLE_BATCH_MAX) sampleBatch[sampleBatchCount++] = cm;
}

// ---------------------------------------------------------------------------
// Server link
// ---------------------------------------------------------------------------

// Resolved once per connection and cached. mDNS is tried first so the PC can
// change DHCP address without stranding the board; the compiled-in IP is only
// the fallback for when mDNS is unavailable (some routers block it).
static String resolvedHost = "";

static void resolveServerHost() {
  IPAddress ip = MDNS.queryHost(SERVER_MDNS, 3000);
  // A resolved address is only preferred over the compiled-in one if it is
  // actually plausible. A resolver answering with something off-network would
  // otherwise be latched in permanently.
  if (ip != IPAddress((uint32_t)0) && ip[0] == WiFi.localIP()[0] && ip[1] == WiFi.localIP()[1]) {
    resolvedHost = ip.toString();
    Serial.printf("[mdns] %s.local -> %s\n", SERVER_MDNS, resolvedHost.c_str());
  } else {
    resolvedHost = SERVER_HOST;
    Serial.printf("[mdns] no usable answer, using %s\n", SERVER_HOST);
  }
}

static String serverBase() {
  return String("http://") + (resolvedHost.length() ? resolvedHost : SERVER_HOST) + ":" + String(SERVER_PORT);
}

static unsigned long lastServerOkAt = 0;

// Resolving the server once at boot is not enough. The board is normally
// powered before the PC, so the first lookup happens while nothing is there to
// answer it, and a wrong or stale answer would then stick forever -- which is
// exactly how it ended up posting into the void after a reboot. Repeated
// failures trigger a fresh lookup instead.
static int consecutiveFailures = 0;
static const int FAILURES_BEFORE_RERESOLVE = 5;
static int lastPollCode = 0;

// Fire-and-forget event POST. The server decides what it means.
static bool postEvent(const String &json) {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(serverBase() + "/api/hardware/event")) return false;
  http.addHeader("Content-Type", "application/json");

  int code = http.POST(json);
  http.end();

  bool ok = code > 0 && code < 400;
  if (ok) lastServerOkAt = millis();
  Serial.printf("[event] %s -> %d\n", json.c_str(), code);
  return ok;
}

// Everything the display needs, as last reported by the server.
struct UiState {
  String mode = "idle";  // idle | arming | running | paused
  long remainingSeconds = 0;
  long todaySeconds = 0;
  long sessionsToday = 0;
  long armSeconds = 0;
  bool valid = false;
};
static UiState ui;

// Every number on this display is computed by the app and read verbatim. The
// firmware deliberately does no arithmetic on the timer or the daily totals --
// if it did, its idea of "3 sessions today" could drift from the app's, and
// there would be two competing definitions of the same fact. Latency is dealt
// with by polling often, not by extrapolating locally.

// Minimal field extraction. A JSON library would be overkill for a flat object
// of four known keys that we generate ourselves on the server side.
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

// Pulls the sensor tuning the app's settings page publishes. A failure just
// leaves the previous values in force -- the board keeps working on whatever it
// last knew rather than reverting to compiled-in defaults mid-session.
static void pollConfig() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(serverBase() + "/api/hardware/config")) return;

  if (http.GET() == 200) {
    String body = http.getString();
    long n = 0;
    // Thresholds, dwell times and glitch handling are all read by the app's
    // filter now, not here. The ping rate is the only setting that describes
    // what the board physically does, so it is the only one it still reads.
    if (jsonNumber(body, "sampleIntervalMs", n)) cfg.sampleIntervalMs = constrain(n, 40L, 2000L);
  }
  http.end();
}

// Ships the pings collected since the last batch.
//
// Batched rather than sent one at a time because each POST costs a TCP
// connection: at a 100 ms ping rate, posting individually would mean ten round
// trips a second and the board would spend most of its life inside HTTPClient.
// A batch every few hundred milliseconds is one extra request per existing
// poll cycle, and still lands every sample well inside the shortest dwell time
// the filter uses.
//
// `dt` rather than timestamps: the board's millis() and the PC's clock share no
// epoch, and millis() restarts on every reset, so the server reconstructs the
// sample times backwards from the moment the batch arrived instead.
static void postSamples() {
  String cmList = "[";
  for (int i = 0; i < sampleBatchCount; i++) {
    if (i) cmList += ",";
    cmList += String(sampleBatch[i], 1);
  }
  cmList += "]";
  sampleBatchCount = 0;

  // Raw button levels ride along: a button that produces no events at all is
  // otherwise indistinguishable from one that is never pressed, and the board
  // has no cable attached to check with.
  postEvent(String("{\"type\":\"samples\",\"dt\":") + String(cfg.sampleIntervalMs) +
            ",\"cm\":" + cmList +
            ",\"btnA\":" + String(digitalRead(PIN_BTN_A)) +
            ",\"btnB\":" + String(digitalRead(PIN_BTN_B)) +
            ",\"edgesA\":" + String(btnAEdges) +
            ",\"edgesB\":" + String(btnBEdges) +
            ",\"host\":\"" + resolvedHost + "\"" +
            ",\"pollCode\":" + String(lastPollCode) +
            ",\"uiMode\":\"" + ui.mode + "\"" +
            ",\"uiValid\":" + (ui.valid ? "true" : "false") + "}");
}

static void pollState() {
  if (WiFi.status() != WL_CONNECTED) {
    ui.valid = false;
    return;
  }

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(serverBase() + "/api/hardware/state")) {
    ui.valid = false;
    return;
  }

  int code = http.GET();
  lastPollCode = code;
  if (code == 200) {
    String body = http.getString();
    String mode;
    if (jsonString(body, "mode", mode)) ui.mode = mode;
    jsonNumber(body, "remainingSeconds", ui.remainingSeconds);
    jsonNumber(body, "todaySeconds", ui.todaySeconds);
    jsonNumber(body, "sessionsToday", ui.sessionsToday);
    jsonNumber(body, "armSeconds", ui.armSeconds);
    ui.valid = true;
    consecutiveFailures = 0;
    lastServerOkAt = millis();

    // Re-announcing presence to a window that has just appeared used to be
    // done from here, because the board was the thing that knew when the link
    // came back. It is now the server's job: it holds the presence filter, so
    // it already knows the answer without being told, and it can see a window
    // opening directly (see /api/hardware/events).
  }
  else {
    Serial.printf("[poll] failed: %d (host %s)\n", code, resolvedHost.c_str());
    if (++consecutiveFailures >= FAILURES_BEFORE_RERESOLVE) {
      consecutiveFailures = 0;
      http.end();
      resolveServerHost();
      return;
    }
  }
  // A failed poll deliberately leaves the last good values in place. One
  // dropped request is normal and must not blank the screen -- the staleness
  // window below is what decides the link is really down, and until it expires
  // the locally-ticking clock carries the display.
  http.end();
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

static void renderLcd(bool linkUp) {
  if (!linkUp) {
    lcdShow(0, "No connection");
    lcdShow(1, WiFi.status() == WL_CONNECTED ? "Server down" : "WiFi down");
    return;
  }

  // The server answers "offline" when it is up but no app window is driving the
  // controller -- which is the normal state for the first several seconds after
  // the PC boots, since the board is already running by then. This used to fall
  // through to the branch below and draw "Ready / 0m 0 done": not a delay but a
  // flat lie, indistinguishable from a real day with no sessions in it.
  if (ui.mode == "offline") {
    lcdShow(0, "Waiting for app");
    lcdShow(1, "Planner not open");
    return;
  }

  if (ui.mode == "arming") {
    lcdShow(0, "Starting in " + String(ui.armSeconds) + "s");
  } else if (ui.mode == "running") {
    lcdShow(0, mmss(ui.remainingSeconds));
  } else if (ui.mode == "paused") {
    lcdShow(0, mmss(ui.remainingSeconds) + " PAUSED");
  } else {
    lcdShow(0, "Ready");
  }

  // Second line mirrors the widget's "Today 2h 30m - 3 done", squeezed to fit
  // 16 cells: the leading "Today" is dropped since the numbers speak for
  // themselves and the worst case ("12h 30m  10 done") is exactly 16.
  lcdShow(1, hoursMinutes(ui.todaySeconds) + "  " + String(ui.sessionsToday) + " done");
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

// Active-LOW via INPUT_PULLUP, captured by interrupt rather than polled.
//
// Polling cannot catch a quick tap here: pulseIn() blocks for up to 30ms per
// sensor reading and an HTTP request blocks for far longer, so a press that
// begins and ends between two digitalRead() calls is simply never seen. An
// interrupt latches the press the instant it happens, whatever the main loop
// is busy with, and the loop drains the latch when it gets around to it.
// Presses are identified by how long the line is actually held down, measured
// entirely inside the interrupt.
//
// The buttons here run on long parallel wires with only the weak internal
// pull-up holding them high, so pressing one couples a spike into the other:
// every press of A produced a phantom B about 80ms later, which terminated the
// session. A finger holds a line down for tens of milliseconds; induced
// coupling lasts microseconds. Timing the pulse tells them apart with no
// ambiguity and no extra hardware.
//
// It has to be done in the ISR, not the main loop: the loop blocks for 50-100ms
// on HTTP requests, so anything that samples the pin "shortly after" the edge
// is really sampling whenever the loop next gets a turn -- long after a quick
// tap has been released, which threw away real presses.
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

static void IRAM_ATTR traceEdge(int pin, int level, unsigned long us, unsigned long width) {
  const int i = edgeTraceHead;
  edgeTrace[i].us = us;
  edgeTrace[i].pin = pin;
  edgeTrace[i].level = level;
  edgeTrace[i].width = width;
  edgeTraceHead = (i + 1) % 12;
  if (edgeTracePending < 12) edgeTracePending++;
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

static unsigned long lastAcceptedAt = 0;
static int lastAcceptedPin = -1;

// Rejections are reported to the app's log as well as the serial monitor: the
// board normally runs on a phone charger with no cable attached, and a button
// that silently does nothing is impossible to diagnose from the desk.
static void reportRejected(const char *event, unsigned long widthUs) {
  Serial.printf("[btn] %s rejected: %luus pulse\n", event, widthUs);
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(serverBase() + "/api/hardware/log")) return;
  http.addHeader("Content-Type", "application/json");
  http.POST(String("{\"source\":\"firmware\",\"rejected\":\"") + event + "\",\"widthUs\":" + String(widthUs) + "}");
  http.end();
}

static void acceptButton(int pin, const char *event, unsigned long now) {
  // Belt and braces on top of the pulse-width test: two different buttons a
  // fraction of a second apart is not something a hand does.
  if (lastAcceptedPin != -1 && lastAcceptedPin != pin && now - lastAcceptedAt < BTN_CROSS_LOCKOUT_MS) {
    Serial.printf("[btn] %s rejected: %lums after the other button\n", event, now - lastAcceptedAt);
    return;
  }
  lastAcceptedAt = now;
  lastAcceptedPin = pin;
  Serial.printf("[btn] %s\n", event);
  postEvent(String("{\"type\":\"") + event + "\"}");
}

static void drainButtons(unsigned long now) {
  if (btnAPressed) { btnAPressed = false; acceptButton(PIN_BTN_A, "button_a", now); }
  if (btnBPressed) { btnBPressed = false; acceptButton(PIN_BTN_B, "button_b", now); }

  if (btnARejectedUs) { const unsigned long w = btnARejectedUs; btnARejectedUs = 0; reportRejected("button_a", w); }
  if (btnBRejectedUs) { const unsigned long w = btnBRejectedUs; btnBRejectedUs = 0; reportRejected("button_b", w); }

  // Flush the raw edge trace, one entry per pass so a burst cannot stall the
  // loop with a queue of HTTP posts.
  if (edgeTracePending > 0 && WiFi.status() == WL_CONNECTED) {
    noInterrupts();
    const int idx = (edgeTraceHead - edgeTracePending + 12) % 12;
    const EdgeTrace e = { edgeTrace[idx].us, edgeTrace[idx].pin, edgeTrace[idx].level, edgeTrace[idx].width };
    edgeTracePending--;
    interrupts();

    HTTPClient http;
    http.setTimeout(HTTP_TIMEOUT_MS);
    if (http.begin(serverBase() + "/api/hardware/log")) {
      http.addHeader("Content-Type", "application/json");
      http.POST(String("{\"source\":\"edge\",\"pin\":") + e.pin + ",\"level\":" + e.level +
                ",\"us\":" + e.us + ",\"width\":" + e.width + "}");
      http.end();
    }
  }
}

// ---------------------------------------------------------------------------

static void connectWifi() {
  Serial.printf("[wifi] joining %s\n", WIFI_SSID);
  lcdShow(0, "WiFi...");
  lcdShow(1, WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // sleep adds seconds of latency to the 1s poll
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_JOIN_TIMEOUT_MS) {
    delay(250);
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] connected, ip=%s\n", WiFi.localIP().toString().c_str());

    // Own hostname, so the board itself is reachable as planner-desk.local for
    // OTA without having to hunt for its address.
    MDNS.begin("planner-desk");
    resolveServerHost();
  } else {
    Serial.println("[wifi] join failed -- will keep retrying");
  }
}

// Over-the-air updates, so firmware changes no longer need the board carried
// to the PC and plugged in. The display says what is happening -- an update
// that appears to hang is otherwise indistinguishable from a crash.
static void setupOta() {
  ArduinoOTA.setHostname("planner-desk");
  ArduinoOTA.setPassword(OTA_PASSWORD);

  ArduinoOTA.onStart([]() {
    lcdLine0Shown = "";  // force a full repaint over whatever was there
    lcdLine1Shown = "";
    lcdShow(0, "OTA update");
    lcdShow(1, "0%");
    Serial.println("[ota] start");
  });
  ArduinoOTA.onProgress([](unsigned int done, unsigned int total) {
    if (!total) return;
    lcdShow(1, String((done * 100) / total) + "%");
  });
  ArduinoOTA.onEnd([]() {
    lcdShow(0, "OTA done");
    lcdShow(1, "rebooting");
    Serial.println("[ota] done");
  });
  ArduinoOTA.onError([](ota_error_t err) {
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
  ui.mode = "running";
  ui.remainingSeconds = 3600;
  ui.todaySeconds = 9000;
  ui.valid = true;
  lastServerOkAt = millis();
#else
  // WiFi auto-reconnects in the background; the loop tolerates it being down.
  WiFi.setAutoReconnect(true);
  connectWifi();
  setupOta();
#endif
}

void loop() {
  unsigned long now = millis();

#if !DIAG_NO_WIFI
  ArduinoOTA.handle();
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
  // Ping, remember, ship. No thresholds, no median, no state: the board has no
  // opinion about what any of these numbers mean, which is the point. Deciding
  // presence needs several seconds of context and a good deal of arithmetic,
  // and doing it here would mean reflashing to change any of it.
  static unsigned long lastSample = 0;
  if (now - lastSample >= (unsigned long)cfg.sampleIntervalMs) {
    lastSample = now;
    pushSample(pingOnce());
  }

  // A batch goes out on a fixed cadence rather than when the buffer fills, so
  // the filter's dwell timers advance at a steady rate however the ping rate is
  // tuned. The heartbeat interval keeps the button levels and link diagnostics
  // flowing even at ping rates too slow to produce a sample every batch.
  static unsigned long lastBatch = 0;
  if (now - lastBatch >= SAMPLE_BATCH_MS
      && (sampleBatchCount > 0 || now - lastBatch >= SAMPLE_HEARTBEAT_MS)) {
    lastBatch = now;
    postSamples();
  }

  // --- server poll ---
  static unsigned long lastPoll = 0;
  if (now - lastPoll >= STATE_POLL_INTERVAL_MS) {
    lastPoll = now;
    if (WiFi.status() != WL_CONNECTED) {
      static unsigned long lastRetry = 0;
      if (now - lastRetry > 10000) {
        lastRetry = now;
        WiFi.reconnect();
      }
    } else {
      pollState();
    }
  }

  // --- config poll ---
  static unsigned long lastConfigPoll = 0;
  if (now - lastConfigPoll >= CONFIG_POLL_INTERVAL_MS) {
    lastConfigPoll = now;
    pollConfig();
  }

  // --- display + LED ---
  // Re-read the clock: the poll above blocks for tens of milliseconds and
  // stamps lastServerOkAt with a time later than the `now` captured
  // at the top of the loop. Comparing against that stale value underflowed and
  // flashed "No connection" once per poll.
  now = millis();

  // Judged purely on how long it has been since the server was last reached,
  // so transient request failures ride through instead of flashing an error.
  const long sinceOk = static_cast<long>(now - lastServerOkAt);
  bool linkUp = ui.valid && sinceOk < static_cast<long>(SERVER_STALE_MS);

  static bool lastLinkUp = true;
  if (linkUp != lastLinkUp) {
    lastLinkUp = linkUp;
    // Wipe line caches on state change so the new message is fully drawn
    lcdLine0Shown = "";
    lcdLine1Shown = "";
    Serial.printf("[link] %s (valid=%d wifi=%d sinceOk=%ldms)\n", linkUp ? "UP" : "DOWN", ui.valid ? 1 : 0,
                  WiFi.status() == WL_CONNECTED ? 1 : 0, sinceOk);
  }

  renderLcd(linkUp);

  // Green strictly tracks "a session is counting right now" -- arming does not
  // qualify, since nothing is being recorded yet.
  externalLeds(linkUp && ui.mode == "running");

  LedState led;
  // An app that is not there yet is as good as no link as far as the status
  // light is concerned -- it must not sit on the calm idle colour as though
  // everything were up and simply quiet.
  if (!linkUp || ui.mode == "offline") led = LED_OFFLINE;
  else if (ui.mode == "arming") led = LED_ARMING;
  else if (ui.mode == "running") led = LED_RUNNING;
  else led = LED_IDLE;
  ledApply(led, (now / 400) % 2 == 0);

  delay(5);
}
