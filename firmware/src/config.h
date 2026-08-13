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
// Presence detection
// ---------------------------------------------------------------------------
// Measured on this desk: seated reads 30-39 cm, empty chair reads 57-59 cm.
// Two thresholds instead of one gives hysteresis -- once you are detected as
// present it takes a clearly larger distance to drop you, so a reading sitting
// right on the boundary cannot rattle the state back and forth.
//
// NOTE: these are only the fallbacks used before the app has been reached.
// The live values come from the app's settings over /api/hardware/config, so
// the sensor can be retuned without plugging the board into the PC.
#define PRESENCE_ENTER_CM 48.0f  // absent -> present when median drops below this
#define PRESENCE_EXIT_CM 52.0f   // present -> absent when median rises above this

// Readings outside this band are physically implausible for a desk and are
// discarded before they can pollute the filter.
#define DIST_MIN_VALID_CM 4.0f
#define DIST_MAX_VALID_CM 300.0f

// A single HC-SR04 ping is noisy and occasionally returns nonsense. We sample
// fast and take the MEDIAN of a sliding window: unlike an average, one wild
// outlier cannot drag the result at all, it just gets sorted to an end and
// ignored. An odd window size means there is always a true middle element.
#define SAMPLE_INTERVAL_MS 100
#define MEDIAN_WINDOW 5

// The sample ring is a fixed array, so the window the app may request has to be
// bounded at compile time. Keep in step with MEDIAN_WINDOW_MAX in
// hardwareController.ts.
#define MEDIAN_WINDOW_MAX 15

// How often the board re-reads its tuning from the app.
#define CONFIG_POLL_INTERVAL_MS 3000

// While calibrating, how often the live distance is streamed to the settings
// page. Fast enough to feel live, slow enough not to flood the dev server.
#define CALIBRATION_STREAM_MS 250

// Outside calibration the reading is still streamed, just slower, so the
// settings page can always show what the sensor sees. Being able to watch the
// live number is the difference between diagnosing a placement problem and
// guessing at one.
#define LIVE_STREAM_MS 1000

// Even a clean median flickers while you shift in your seat, so a candidate
// state must hold continuously for this long before it is believed. Leaving is
// given a longer fuse than arriving: briefly leaning out of the beam to grab
// something should not read as "left the desk".
#define PRESENT_CONFIRM_MS 2000
#define ABSENT_CONFIRM_MS 5000

// A timeout means nothing echoed back, i.e. nothing is in front of the sensor.
// That is a legitimate "absent" observation, not a failed reading, so it feeds
// the filter as a far distance rather than being thrown away.
#define DIST_TIMEOUT_AS_CM 400.0f

// Cheap ultrasonic modules occasionally spray maximum-range values for a second
// or two for no reason. There is a wall behind this desk, so nothing can
// legitimately read past about a metre -- anything further is the module
// misfiring, and is dropped rather than fed to the filter.
//
// Dropping alone would be dangerous: an empty desk with nothing at all in the
// beam produces exactly the same readings, so discarding them forever would
// mean leaving was never detected. A run that survives GLITCH_HOLD_MS unbroken
// is therefore believed and allowed through. Fallbacks only -- the live values
// come from the app's settings.
#define GLITCH_MAX_CM 100.0f
#define GLITCH_HOLD_MS 10000

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
// Status LED
// ---------------------------------------------------------------------------
// Dimmed heavily: the onboard WS2812 is painfully bright at full scale.
#define LED_BRIGHTNESS 40
