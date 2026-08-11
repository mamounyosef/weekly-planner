// ---------------------------------------------------------------------------
// Weekly Planner -- focus timer hardware controller (ESP32-S3).
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
#include <HTTPClient.h>
#include <LiquidCrystal_I2C.h>
#include <WiFi.h>
#include <Wire.h>

#include "config.h"
#include "secrets.h"

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

// Most PCF8574 backpacks are 0x27, some are 0x3F. Detected at boot.
static uint8_t lcdAddr = 0x27;
static LiquidCrystal_I2C *lcd = nullptr;

// The LCD is slow (~40ms for a full repaint) and redrawing identical text makes
// it visibly flicker, so each line is only pushed when it actually changes.
static String lcdLine0Shown = "";
static String lcdLine1Shown = "";

static void lcdShow(uint8_t row, const String &text) {
  String padded = text;
  while (padded.length() < 16) padded += ' ';
  padded = padded.substring(0, 16);

  String &cache = row == 0 ? lcdLine0Shown : lcdLine1Shown;
  if (cache == padded) return;

  // Repainting the whole line every second (which is what a ticking clock
  // does) blanks and redraws all 16 cells, and that reads as a flicker. Only
  // the runs of characters that actually differ are pushed, so a ticking
  // seconds field touches two cells instead of sixteen.
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

// One HC-SR04 ping. Returns distance in cm, or DIST_TIMEOUT_AS_CM when nothing
// echoes back (which means "clear ahead", not "measurement failed").
static float pingOnce() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(3);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);

  unsigned long us = pulseIn(PIN_ECHO, HIGH, 30000UL);
  if (us == 0) return DIST_TIMEOUT_AS_CM;

  float cm = us / 58.0f;
  if (cm < DIST_MIN_VALID_CM || cm > DIST_MAX_VALID_CM) return DIST_TIMEOUT_AS_CM;
  return cm;
}

static float sampleRing[MEDIAN_WINDOW];
static int sampleCount = 0;
static int sampleHead = 0;

static void pushSample(float cm) {
  sampleRing[sampleHead] = cm;
  sampleHead = (sampleHead + 1) % MEDIAN_WINDOW;
  if (sampleCount < MEDIAN_WINDOW) sampleCount++;
}

// Median rather than mean: a single spurious reading gets sorted to one end and
// has no influence at all, whereas an average would let it shift the result.
static float medianDistance() {
  if (sampleCount == 0) return DIST_TIMEOUT_AS_CM;

  float sorted[MEDIAN_WINDOW];
  for (int i = 0; i < sampleCount; i++) sorted[i] = sampleRing[i];
  for (int i = 1; i < sampleCount; i++) {
    float key = sorted[i];
    int j = i - 1;
    while (j >= 0 && sorted[j] > key) {
      sorted[j + 1] = sorted[j];
      j--;
    }
    sorted[j + 1] = key;
  }
  return sorted[sampleCount / 2];
}

// Confirmed presence state, and the candidate currently being timed.
static bool presencePresent = false;
static bool presenceCandidate = false;
static unsigned long candidateSince = 0;
static bool presenceInitialized = false;

// Feeds one median through the hysteresis + dwell-time logic.
// Returns true when the confirmed state just flipped.
static bool updatePresence(float median, unsigned long now) {
  // The very first full window establishes where we stand, with no dwell time.
  // Without this the boot state would be published as "absent" no matter what
  // the sensor sees -- which, after a mid-session reset, would pause a session
  // while you are sitting right in front of it.
  if (!presenceInitialized) {
    presenceInitialized = true;
    presencePresent = median < PRESENCE_ENTER_CM;
    presenceCandidate = presencePresent;
    candidateSince = now;
    return true;
  }

  // Hysteresis: the bar to change state depends on the state we are in, so a
  // distance hovering near the threshold cannot oscillate.
  bool raw = presencePresent ? (median <= PRESENCE_EXIT_CM) : (median < PRESENCE_ENTER_CM);

  if (raw != presenceCandidate) {
    presenceCandidate = raw;
    candidateSince = now;
    return false;
  }
  if (raw == presencePresent) return false;

  // Leaving needs a longer confirmation than arriving -- briefly leaning out of
  // the beam should not count as walking away.
  unsigned long needed = raw ? PRESENT_CONFIRM_MS : ABSENT_CONFIRM_MS;
  if (now - candidateSince < needed) return false;

  presencePresent = raw;
  return true;
}

// ---------------------------------------------------------------------------
// Server link
// ---------------------------------------------------------------------------

static String serverBase() {
  return String("http://") + SERVER_HOST + ":" + String(SERVER_PORT);
}

static unsigned long lastServerOkAt = 0;

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
  if (code == 200) {
    String body = http.getString();
    String mode;
    if (jsonString(body, "mode", mode)) ui.mode = mode;
    jsonNumber(body, "remainingSeconds", ui.remainingSeconds);
    jsonNumber(body, "todaySeconds", ui.todaySeconds);
    jsonNumber(body, "sessionsToday", ui.sessionsToday);
    jsonNumber(body, "armSeconds", ui.armSeconds);
    ui.valid = true;
    lastServerOkAt = millis();
  }
  else {
    Serial.printf("[poll] failed: %d\n", code);
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
static const unsigned long BTN_LOCKOUT_US = 40000;  // 40ms, swallows contact bounce

static volatile bool btnAPressed = false;
static volatile bool btnBPressed = false;
static volatile unsigned long btnALastUs = 0;
static volatile unsigned long btnBLastUs = 0;

static void IRAM_ATTR onBtnA() {
  unsigned long us = micros();
  if (us - btnALastUs < BTN_LOCKOUT_US) return;
  btnALastUs = us;
  btnAPressed = true;
}

static void IRAM_ATTR onBtnB() {
  unsigned long us = micros();
  if (us - btnBLastUs < BTN_LOCKOUT_US) return;
  btnBLastUs = us;
  btnBPressed = true;
}

static void drainButtons() {
  if (btnAPressed) {
    btnAPressed = false;
    Serial.println("[btn] A");
    postEvent("{\"type\":\"button_a\"}");
  }
  if (btnBPressed) {
    btnBPressed = false;
    Serial.println("[btn] B");
    postEvent("{\"type\":\"button_b\"}");
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
  } else {
    Serial.println("[wifi] join failed -- will keep retrying");
  }
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
  attachInterrupt(digitalPinToInterrupt(PIN_BTN_A), onBtnA, FALLING);
  attachInterrupt(digitalPinToInterrupt(PIN_BTN_B), onBtnB, FALLING);

  Wire.begin(PIN_SDA, PIN_SCL);
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
  lcd->init();
  lcd->backlight();

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
#endif
}

void loop() {
  unsigned long now = millis();

  drainButtons();

  // --- sensor ---
  static unsigned long lastSample = 0;
  if (now - lastSample >= SAMPLE_INTERVAL_MS) {
    lastSample = now;
    pushSample(pingOnce());

    // Wait for a full window before trusting the median, otherwise the very
    // first readings decide the state on partial evidence.
    if (sampleCount >= MEDIAN_WINDOW) {
      float med = medianDistance();
      bool flipped = updatePresence(med, now);

      if (flipped) {
        Serial.printf("[presence] %s (median %.1f cm)\n", presencePresent ? "PRESENT" : "ABSENT", med);
        postEvent(String("{\"type\":\"presence\",\"present\":") + (presencePresent ? "true" : "false") +
                  ",\"distanceCm\":" + String(med, 1) + "}");
      }
    }
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
    Serial.printf("[link] %s (valid=%d wifi=%d sinceOk=%ldms)\n", linkUp ? "UP" : "DOWN", ui.valid ? 1 : 0,
                  WiFi.status() == WL_CONNECTED ? 1 : 0, sinceOk);
  }

  renderLcd(linkUp);

  // Green strictly tracks "a session is counting right now" -- arming does not
  // qualify, since nothing is being recorded yet.
  externalLeds(linkUp && ui.mode == "running");

  LedState led;
  if (!linkUp) led = LED_OFFLINE;
  else if (ui.mode == "arming") led = LED_ARMING;
  else if (ui.mode == "running") led = LED_RUNNING;
  else led = LED_IDLE;
  ledApply(led, (now / 400) % 2 == 0);

  delay(5);
}
