// ---------------------------------------------------------------------------
// Tunables. Everything you might want to change lives here.
// ---------------------------------------------------------------------------
#pragma once

// --- pin map ---
// The GOOUUU carrier's camera consumes GPIO 4,5,6,7,8,9,10,11,12,13,15,16,17,18
// and the carrier itself holds GPIO 4/5 low, so every peripheral here lives on
// pins outside that set. Also avoided: 19/20 (USB), 26-37 (flash/PSRAM),
// 43/44 (UART0), 0/3/45/46 (strapping).
#define PIN_SDA 21
#define PIN_SCL 47
#define PIN_TRIG 40
#define PIN_ECHO 41
#define PIN_BTN_A 38  // start / pause / resume
#define PIN_BTN_B 39  // terminate
#define PIN_LED 48    // onboard addressable RGB (WS2812)

// External status LEDs, each via a 220R series resistor to GND. Green means a
// focus session is counting; yellow means it is not (idle, paused, terminated,
// or the link to the app is down). Exactly one is lit at any time.
#define PIN_LED_GREEN 42
#define PIN_LED_YELLOW 2

// ---------------------------------------------------------------------------
// Ultrasonic sensor
// ---------------------------------------------------------------------------
// The board does not decide presence. It pings, buffers the raw centimetres,
// and posts them; the app's filter (artifacts/weekly-planner/src/lib/
// sensorFilter.ts) is what turns that stream into "at the desk" / "away".
//
// That split is deliberate. Telling a real departure apart from a partially
// blocked transducer takes seconds of context, cluster statistics and several
// tunable rules -- none of which belong on a microcontroller that has to be
// reflashed to change any of them. Down here the only question is how often to
// look and how often to send.

// How often to ping. Fallback only: the live value comes from the app's
// settings over /api/hardware/config, so the rate can be changed without
// plugging the board into the PC.
#define SAMPLE_INTERVAL_MS 100

// How often the collected pings are shipped. One POST per batch rather than
// per ping: each POST costs a TCP connection, and at 100 ms pings the board
// would otherwise spend its life inside HTTPClient. 400 ms still puts every
// sample in front of the filter a long way inside its shortest dwell time.
#define SAMPLE_BATCH_MS 400

// Even with no samples to send (a ping rate slower than the batch interval), a
// batch goes out this often so the button levels and link diagnostics riding
// along with it keep flowing.
#define SAMPLE_HEARTBEAT_MS 1000

// The batch buffer. Sized well past what one batch interval can produce at the
// fastest allowed ping rate (400 / 40 = 10), so a slow or retried POST cannot
// make the board silently drop readings the filter is counting on.
#define SAMPLE_BATCH_MAX 32

// How often the board re-reads its tuning from the app.
#define CONFIG_POLL_INTERVAL_MS 3000

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------
// Polled twice a second, matching the app's publish rate. The firmware does no
// local extrapolation between polls -- the app owns every number -- so this
// interval is what bounds how stale the display can look.
#define STATE_POLL_INTERVAL_MS 500
#define HTTP_TIMEOUT_MS 3000

// The carrier's AP logs a spurious AUTH_FAIL on first join (WPA2/WPA3 mixed
// mode), so the join timeout has to be generous enough to survive one retry.
#define WIFI_JOIN_TIMEOUT_MS 20000

// How long the server can go unreachable before we call the link down and show
// the "not working" colour.
#define SERVER_STALE_MS 5000

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
// Set to 1 to run the display off a free-running local clock with WiFi and the
// status LED disabled. Used to tell an electrical fault (rail sag from WiFi TX
// bursts, marginal I2C levels) apart from a redraw bug: if the display is
// steady like this but flickers with WiFi up, the problem is power, not code.
#define DIAG_NO_WIFI 0

// ---------------------------------------------------------------------------
// LCD Resilience & Auto-Healing
// ---------------------------------------------------------------------------
// How often the HD44780 controller hardware state machine is forcibly
// resynchronized (clearing any 4-bit nibble desync, CGRAM corruptions, or mode errors).
#define LCD_RESYNC_INTERVAL_MS 30000

// How often the full 16x2 character grid is refreshed regardless of diffs,
// wiping away any single-character bit flips or noise glitches.
#define LCD_FORCE_REFRESH_MS 5000

// ---------------------------------------------------------------------------
// Status LED
// ---------------------------------------------------------------------------
// Dimmed heavily: the onboard WS2812 is painfully bright at full scale.
#define LED_BRIGHTNESS 40

