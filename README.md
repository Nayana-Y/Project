# Kisan Sathi — Project Documentation

Kisan Sathi ("Farmer's Companion") is a 4-language (English, Hindi, Odia,
Kannada) smart-farming assistant. It combines an AI chat/voice assistant,
crop and soil guidance, live weather with push alerts, an IoT field
dashboard, a dealer/storage locator, government scheme info, and real
accounts backed by MongoDB — all as a single Express server serving a
static multi-page site.

---

## 1. Repository Layout

```
NIIS-HACKTHON/
├── pages/              Static HTML site — 19 pages + favicon.svg + sw.js + config.js
├── models/              Mongoose schemas: Farmer, Complaint, PushSubscription, SensorReading
├── scripts/              sensor-simulator.js — posts fake IoT readings for demo purposes
├── server.js             Express API (see §3)
├── package.json / package-lock.json
├── netlify.toml           Pins Netlify's publish directory to pages/
├── .env                   GEMINI_API_KEY, MONGODB_URI, JWT_SECRET, VAPID_* (gitignored)
└── .gitignore
```

---

## 2. Features by Page

### AI & Voice

| Page | What it does |
|---|---|
| `chat.html` | Gemini-powered chat assistant. Free-text Q&A plus 30 preset quick-topics, all in 4 languages. Also supports: **photo-based crop disease diagnosis** (camera button → `/detect-disease`), **voice input** (Web Speech API) and **read-aloud** replies (speech synthesis), markdown-formatted AI replies, follow-up suggestion chips, and conversation history persisted in `localStorage`. |
| `voiceai.html` | A voice-first variant of the assistant: mic input via Web Speech API, replies from the same `/chat` backend, and **every reply is automatically read aloud** (not just on request, unlike `chat.html`). Includes a 17-item quick-command panel. *Caveat: browsers have no reliable Odia text-to-speech voice, so Odia replies fall back to Hindi speech synthesis.* |
| `diseases.html` | Standalone crop disease detector. Drag-and-drop or click-to-upload a photo (client-side compressed), sent to `/detect-disease`; returns disease name, confidence, a numbered treatment plan, and a tip — all AI-generated per photo via Gemini Vision. |

### Crop & Farm Health

| Page | What it does |
|---|---|
| `crop.html` | Searchable/filterable database of **28 crops** (season, soil type, fertilizer, growing months, use-case, category). If a soil test was run, matching crops are highlighted and sorted to the top (see below). |
| `soiltest.html` | Rule-based soil-type classifier: user enters texture/pH/moisture/organic content, gets a matched soil profile (10 types), recommended crops, and care tips. Hands its result to `crop.html` via `localStorage` so the two pages work together. |
| `weather.html` | Live weather via OpenWeatherMap (current + 5-day forecast + hourly), with farming advisories. Also the entry point for **real push notifications**: a subscribe button registers a service worker and the browser's Push API; a server-side cron job checks live conditions every 30 minutes and pushes an alert (thunderstorm / active rain / extreme heat / frost risk) — deduplicated to once per condition per day. |
| `iot-dashboard.html` | Live soil-sensor dashboard (moisture/pH/temperature/humidity) backed by MongoDB, with a Chart.js moisture trend chart, low-moisture push alerts, and an "Analyze Field Photo" tool that sends a drone/aerial photo to Gemini Vision for a field-health assessment. `scripts/sensor-simulator.js` posts realistic fake readings for demoing without real hardware. |

### Market & Schemes

| Page | What it does |
|---|---|
| `mandi.html` | Crop and fertilizer price board — 8 crops, 10 fertilizers, 8 Odisha cities. **Prices are static/hardcoded, not a live feed** — treat as illustrative only. |
| `schemes.html` | 6 real government schemes (PM-KISAN, PMFBY, PM Krishi Sinchai Yojana, Soil Health Card, e-NAM, National Mission for Sustainable Agriculture) plus 5 real bank agri-loan products — all linking to verified official/bank URLs. |
| `equipment.html` | 10 farm equipment items across 4 categories. "Buy" links go to real external vendor sites. **"Rent" is not backed by anything** — it opens a form that only shows a local confirmation message; no request is saved or sent anywhere. This page currently has **no language switcher** (English only), unlike the rest of the site. |
| `location.html` | Real dealer/storage finder on a Leaflet map, backed by live OpenStreetMap Overpass queries — categories: Fertilizer, Seed, Equipment, **Storage/Warehouse**, All. Also includes a **post-harvest storage tips panel** (onion, potato, tomato, grain, pulses). Coverage depends on how well an area is mapped in OSM. |

### Learn & Support

| Page | What it does |
|---|---|
| `education.html` | 14 crop growing guides (Rice, Wheat, Maize, Potato, Tomato, Onion, Cotton, Sugarcane, Groundnut, Mustard, Soybean, Chickpea, Banana, Chilli), each an 8-9 step walkthrough with a real embedded YouTube tutorial, fully translated. |
| `prerana.html` | Motivational + productivity video hub. Each of the 4 languages shows **its own distinct, individually verified set of videos** (not translated captions over the same clip). Includes a visible copyright disclaimer — videos remain the property of their YouTube creators; Kisan Sathi only links to them. |
| `complain.html` | Complaint submission and tracking, backed by MongoDB (`POST/GET/DELETE /complaints`). Complaints are looked up by mobile number, so they're retrievable from any device/browser, not just the one they were filed from. |
| `helpline.html` | Verified helpline directory: Kisan Call Centre, PM-KISAN Helpline, PMFBY crop-insurance helpline, the KIRAN mental-health helpline, and the national emergency number — each a tap-to-call `tel:` link. All numbers were checked against official sources before publishing. |

### Accounts & Landing

| Page | What it does |
|---|---|
| `index.html` | Public marketing landing page. |
| `about.html` | Public about page. |
| `login.html` / `register.html` | Real account creation/login — bcrypt-hashed passwords, JWT session tokens, stored in MongoDB (`Farmer` model). |
| `welcome.html` | Post-login dashboard hub linking to all 15 tools. |

---

## 3. Backend — `server.js`

An Express server exposing:

| Route | Purpose |
|---|---|
| `POST /chat` | Gemini AI text chat (`chat.html`, `voiceai.html`) |
| `POST /detect-disease` | Gemini-vision crop disease detection (`diseases.html`, `chat.html`) |
| `POST /analyze-field-image` | Gemini-vision aerial/drone field health assessment (`iot-dashboard.html`) |
| `GET /dealers` | OpenStreetMap Overpass proxy — dealers *and* storage/warehouses, with multi-mirror fallback and expanding search radius (`location.html`) |
| `POST /register` / `POST /login` | Account creation and login — bcrypt + JWT, backed by MongoDB |
| `POST /complaints`, `GET /complaints?mobile=`, `DELETE /complaints/:id` | Complaint storage, backed by MongoDB |
| `POST /sensor-data`, `GET /sensor-data?deviceId=` | IoT soil-sensor readings, backed by MongoDB (`iot-dashboard.html`) |
| `GET /vapid-public-key`, `POST /subscribe`, `POST /unsubscribe` | Push notification subscription management (weather *or* device-linked low-moisture alerts), backed by MongoDB |
| *(cron, no route)* | Every 30 min: checks each weather subscriber's live conditions (storm/rain/heat/frost), and each device-linked subscriber's latest soil moisture reading — sends a push notification when a threshold is crossed |

Also serves `pages/` as static files, so the whole site runs from one origin.

### Environment variables (`.env`, gitignored)

| Variable | Used for |
|---|---|
| `GEMINI_API_KEY` | Chat + disease detection (Google Gemini) |
| `MONGODB_URI` | Accounts, complaints, and push subscriptions. Routes that need it return `503` if unset rather than crashing. |
| `JWT_SECRET` | Signing login session tokens |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_CONTACT_EMAIL` | Web Push notifications |
| `OPENWEATHER_API_KEY` *(optional)* | Falls back to the key already used client-side in `weather.html` if unset |
| `PORT` *(optional)* | Defaults to `5000` |

### Run it

```
npm install
npm start
```
Then open `http://localhost:5000`.

### Deployment

Deploy as a **single host**: push this repo to a Node host (e.g. Render,
Railway) and run `npm start` there. `server.js` already serves `pages/` as
static files via `express.static`, so the whole site and API share one
origin — `pages/config.js` detects it's not running on `localhost` and
automatically points `API_BASE_URL` at `location.origin`. Nothing to
hand-configure after deploying.

Steps:
1. Push to your Node host of choice.
2. Set all the environment variables from the table above in that host's
   dashboard (they only exist in your local `.env` right now — it's
   gitignored and won't be pushed).
3. In MongoDB Atlas, under Network Access, allow the host's IP (or
   "Allow Access from Anywhere" / `0.0.0.0/0` for simplicity).
4. `npm start` runs `node --env-file-if-exists=.env server.js` — it loads
   `.env` locally if present, and skips it silently on hosts that inject
   env vars directly (which is how most platforms do it), so the same
   start command works in both places without crashing.

(A split deployment — `pages/` on Netlify via `netlify.toml`, backend
elsewhere — is possible too, but would need `pages/config.js` restored to
point at an explicit backend URL instead of `location.origin`, since the
two would then be on different domains.)

---

## 4. Branding

- A custom SVG mark (two cupped strokes cradling a sprout — representing
  "Sathi," a companion supporting new growth) replaced the plain "KS" text
  badge across every page, and the external stock icon previously used on
  `welcome.html`/`index.html`/`about.html`.
- `pages/favicon.svg` — a real favicon, linked from every page (none existed
  before).

---

## 5. Known Limitations (documented honestly)

- **`mandi.html` prices are static**, not a live market feed. A real
  integration (e.g. India's Agmarknet/data.gov.in API) would be needed
  before treating these numbers as accurate.
- **`equipment.html`'s rental flow doesn't persist anywhere** — it's a form
  that shows a confirmation and discards the input. It also has no language
  switcher, unlike every other page.
- **Odia has no browser text-to-speech voice**, so `voiceai.html` and
  `chat.html`'s "Listen" buttons fall back to a Hindi voice for Odia text.
- **OpenStreetMap coverage varies by region** — `location.html`'s dealer and
  storage results depend on what's actually been mapped in OSM near the
  user; some areas will have few or no results.
- Push alerts and MongoDB-backed features require `MONGODB_URI`/`VAPID_*`/
  `JWT_SECRET` to be set on whichever host runs `server.js` — they only
  exist in the local `.env` right now.

---

## 6. Tech Stack Summary

| Layer | Technology |
|---|---|
| UI | Plain HTML/CSS/JS, no build step, 4-language i18n throughout (except `equipment.html`) |
| Backend | Express (`server.js`) |
| Database | MongoDB Atlas via Mongoose (`Farmer`, `Complaint`, `PushSubscription`, `SensorReading`) |
| Auth | bcrypt password hashing + JWT session tokens |
| AI | Google Gemini (`gemini-flash-latest`) — text chat + vision-based disease/field-health detection |
| Weather | OpenWeatherMap (live conditions/forecast + server-side alert cron) |
| IoT | Mongoose-backed sensor readings + Chart.js trend charts + a Node simulator script |
| Push notifications | Web Push (`web-push` + a service worker at `pages/sw.js`) + `node-cron` |
| Maps / dealer data | Leaflet + OpenStreetMap Overpass API |
| Video content | Real embedded/linked YouTube videos (`education.html`, `prerana.html`) |
