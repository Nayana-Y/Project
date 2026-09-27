const express = require("express");
const cors = require("cors");
const path = require("path");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const webpush = require("web-push");
const cron = require("node-cron");

const Farmer = require("./models/Farmer");
const Complaint = require("./models/Complaint");
const PushSubscription = require("./models/PushSubscription");
const SensorReading = require("./models/SensorReading");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "pages")));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-flash-latest";

// Same key already used client-side in pages/weather.html.
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY || "fba453d3138ff243614b8cbc7385a69a";

const JWT_SECRET = process.env.JWT_SECRET;
const MONGODB_URI = process.env.MONGODB_URI;

if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log("MongoDB connected"))
    .catch((err) => console.error("MongoDB connection failed:", err.message));
} else {
  console.warn("MONGODB_URI is not set — accounts, complaints, and push alerts will be unavailable.");
}

// Blocks routes that need the database when it isn't configured/connected, instead of hanging or crashing.
function requireDb(req, res, next) {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: "Database is not connected. Set MONGODB_URI on the server." });
  }
  next();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGemini(body, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    const data = await response.json();

    if (response.ok) {
      return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    }

    if (response.status === 429 || data.error?.status === "RESOURCE_EXHAUSTED") {
      const violation = data.error?.details?.find((d) => d.violations)?.violations?.[0];
      const isDailyQuota = (violation?.quotaId || "").includes("PerDay");
      if (isDailyQuota) {
        throw new Error(
          `Daily free-tier limit reached for the AI model (${violation.quotaValue} requests/day). It resets in about 24 hours — try again later, or use a different API key.`
        );
      }
      // Per-minute rate limit: honor Google's suggested delay and retry.
      if (attempt < retries) {
        const retryInfo = data.error?.details?.find((d) => d.retryDelay);
        const delaySec = parseFloat(retryInfo?.retryDelay) || 5 * (attempt + 1);
        await sleep(Math.min(delaySec, 15) * 1000);
        continue;
      }
      throw new Error(data.error?.message || "Gemini API rate limit exceeded.");
    }

    const isOverloaded = response.status === 503 || data.error?.status === "UNAVAILABLE";
    if (isOverloaded && attempt < retries) {
      const delayMs = Math.min(1500 * Math.pow(2, attempt), 10000); // 1.5s,3s,6s,10s,10s,10s,10s
      await sleep(delayMs);
      continue;
    }
    throw new Error(data.error?.message || "Gemini API error");
  }
}

app.post("/chat", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY is not configured." });
    }

    const { messages } = req.body;
    const systemMessage = messages.find((m) => m.role === "system");
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const body = { contents };
    if (systemMessage) {
      body.systemInstruction = { parts: [{ text: systemMessage.content }] };
    }

    const reply = await callGemini(body);
    res.json({ reply: reply || "No response" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Error connecting to Gemini API" });
  }
});

app.post("/detect-disease", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY is not configured." });
    }

    const { image, lang } = req.body;
    if (!image) {
      return res.status(400).json({ error: "No image provided." });
    }

    const match = image.match(/^data:(.+);base64,(.*)$/s);
    const mimeType = match ? match[1] : "image/jpeg";
    const base64Data = match ? match[2] : image;

    const LANGUAGE_NAMES = { en: "English", hi: "Hindi (Devanagari script)", od: "Odia script", kn: "Kannada script" };
    const languageInstruction = `Respond in ${LANGUAGE_NAMES[lang] || "English"}.`;
    const prompt = `You are an expert plant pathologist helping Indian farmers. Look closely at this crop/leaf photo and identify any visible disease, pest damage, or nutrient deficiency. If the plant looks healthy, say so clearly. ${languageInstruction}
Respond with ONLY valid JSON (no markdown, no code fences), in exactly this shape:
{"disease": "short name of the issue, or 'Healthy Plant'", "confidence": "High", "solution": ["step 1", "step 2", "step 3"], "note": "one short extra tip"}`;

    const body = {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }, { inlineData: { mimeType, data: base64Data } }],
        },
      ],
    };

    let text = await callGemini(body);
    text = text.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { disease: "Analysis complete", confidence: "", solution: [text || "No details returned."], note: "" };
    }

    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Error connecting to Gemini API" });
  }
});

app.post("/analyze-field-image", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY is not configured." });
    }

    const { image, lang } = req.body;
    if (!image) {
      return res.status(400).json({ error: "No image provided." });
    }

    const match = image.match(/^data:(.+);base64,(.*)$/s);
    const mimeType = match ? match[1] : "image/jpeg";
    const base64Data = match ? match[2] : image;

    const LANGUAGE_NAMES = { en: "English", hi: "Hindi (Devanagari script)", od: "Odia script", kn: "Kannada script" };
    const languageInstruction = `Respond in ${LANGUAGE_NAMES[lang] || "English"}.`;
    const prompt = `You are an agronomist reviewing an aerial or wide-angle photo of a farm field (from a drone, phone, or satellite crop). Assess overall field/crop health: canopy vigor and uniformity, visible bare patches or stress zones, water pooling or drainage issues, and any signs of pest/disease pressure visible at this scale. ${languageInstruction}
Respond with ONLY valid JSON (no markdown, no code fences), in exactly this shape:
{"status": "one of: Healthy, Mild Stress, Moderate Stress, Severe Stress", "findings": ["finding 1", "finding 2", "finding 3"], "note": "one short recommended next step"}`;

    const body = {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }, { inlineData: { mimeType, data: base64Data } }],
        },
      ],
    };

    let text = await callGemini(body);
    text = text.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { status: "Analysis complete", findings: [text || "No details returned."], note: "" };
    }

    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Error connecting to Gemini API" });
  }
});

const OVERPASS_ENDPOINTS = [
  "https://lz4.overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const DEALER_TAGS_BY_CATEGORY = {
  fertilizer: [{ k: "shop", v: "agrarian" }],
  seed: [{ k: "shop", v: "agrarian" }],
  equipment: [{ k: "shop", v: "farm" }],
  storage: [{ k: "building", v: "warehouse" }, { k: "man_made", v: "silo" }],
  all: [{ k: "shop", v: "agrarian" }, { k: "shop", v: "farm" }, { k: "shop", v: "garden_centre" }],
};

async function queryOverpass(query) {
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "KisanSathi/1.0 (agricultural dealer finder; farming assistant app)",
          "Accept": "*/*",
        },
        body: "data=" + encodeURIComponent(query),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (response.ok) {
        const data = await response.json();
        if (data && Array.isArray(data.elements)) return data.elements;
      }
    } catch {
      // try next mirror
    }
  }
  return null;
}

app.get("/dealers", async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const category = req.query.category || "all";

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ error: "lat and lng query params are required." });
  }

  const tags = DEALER_TAGS_BY_CATEGORY[category] || DEALER_TAGS_BY_CATEGORY.all;
  const radii = [25000, 75000, 150000, 300000]; // meters: expand until real results are found

  let elements = null;
  let usedRadius = radii[radii.length - 1];
  let mirrorsUnreachable = false;

  for (const radius of radii) {
    // nwr = node/way/relation: buildings like warehouses are usually mapped as ways, not point nodes.
    const filters = tags.map((t) => `nwr["${t.k}"="${t.v}"](around:${radius},${lat},${lng});`).join("");
    const query = `[out:json][timeout:25];(${filters});out center;`;
    const result = await queryOverpass(query);

    if (result === null) {
      mirrorsUnreachable = true;
      break;
    }
    // Ways/relations report their coordinates under `center`; normalize everything to flat lat/lon.
    const normalized = result
      .map((el) => ({ ...el, lat: el.lat ?? el.center?.lat, lon: el.lon ?? el.center?.lon }))
      .filter((el) => typeof el.lat === "number" && typeof el.lon === "number");

    if (normalized.length > 0) {
      elements = normalized;
      usedRadius = radius;
      break;
    }
  }

  if (mirrorsUnreachable) {
    return res.status(502).json({ error: "Couldn't reach OpenStreetMap's data service right now. Please try again in a moment." });
  }

  res.json({ radiusMeters: usedRadius, elements: elements || [] });
});

// ---------- IoT sensor data ----------

app.post("/sensor-data", requireDb, async (req, res) => {
  try {
    const { deviceId, soilMoisture, soilPH, temperature, humidity } = req.body;
    if (!deviceId) {
      return res.status(400).json({ error: "deviceId is required." });
    }
    const doc = await SensorReading.create({ deviceId, soilMoisture, soilPH, temperature, humidity });
    res.json({ ok: true, reading: doc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save sensor reading." });
  }
});

app.get("/sensor-data", requireDb, async (req, res) => {
  const deviceId = req.query.deviceId;
  if (!deviceId) return res.status(400).json({ error: "deviceId query param is required." });
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

  const readings = await SensorReading.find({ deviceId }).sort({ createdAt: -1 }).limit(limit);
  res.json({ readings: readings.reverse() }); // oldest first, ready for charting
});

// ---------- Accounts ----------

function signToken(farmer) {
  return jwt.sign({ id: farmer._id, mobile: farmer.mobile, name: farmer.name }, JWT_SECRET, { expiresIn: "30d" });
}

app.post("/register", requireDb, async (req, res) => {
  try {
    const { name, age, address, mobile, password } = req.body;
    if (!name || !mobile || !password) {
      return res.status(400).json({ error: "name, mobile, and password are required." });
    }
    if (!/^\d{10}$/.test(mobile)) {
      return res.status(400).json({ error: "Please enter a valid 10-digit mobile number." });
    }

    const existing = await Farmer.findOne({ mobile });
    if (existing) {
      return res.status(409).json({ error: "An account with this mobile number already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const farmer = await Farmer.create({ name, age, address, mobile, passwordHash });

    res.json({ ok: true, token: signToken(farmer), name: farmer.name, mobile: farmer.mobile });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

app.post("/login", requireDb, async (req, res) => {
  try {
    const { mobile, password } = req.body;
    if (!mobile || !password) {
      return res.status(400).json({ error: "mobile and password are required." });
    }

    const farmer = await Farmer.findOne({ mobile });
    if (!farmer) {
      return res.status(401).json({ error: "No account found for this mobile number." });
    }

    const valid = await bcrypt.compare(password, farmer.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Incorrect password." });
    }

    res.json({ ok: true, token: signToken(farmer), name: farmer.name, mobile: farmer.mobile });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// ---------- Complaints ----------

app.post("/complaints", requireDb, async (req, res) => {
  try {
    const { name, mobile, category, complaint } = req.body;
    if (!name || !mobile || !category || !complaint) {
      return res.status(400).json({ error: "name, mobile, category, and complaint are required." });
    }
    const doc = await Complaint.create({ name, mobile, category, complaint });
    res.json({ ok: true, complaint: doc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save complaint. Please try again." });
  }
});

app.get("/complaints", requireDb, async (req, res) => {
  const mobile = req.query.mobile;
  if (!mobile) return res.status(400).json({ error: "mobile query param is required." });
  const complaints = await Complaint.find({ mobile }).sort({ createdAt: -1 });
  res.json({ complaints });
});

app.delete("/complaints/:id", requireDb, async (req, res) => {
  await Complaint.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
});

// ---------- Weather push alerts ----------

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_CONTACT_EMAIL = process.env.VAPID_CONTACT_EMAIL || "mailto:admin@example.com";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_CONTACT_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

app.get("/vapid-public-key", (req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(500).json({ error: "Push alerts are not configured on this server." });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post("/subscribe", requireDb, async (req, res) => {
  const { subscription, lat, lng, lang, deviceId } = req.body;
  const hasLocation = typeof lat === "number" && typeof lng === "number";
  if (!subscription || !subscription.endpoint || (!hasLocation && !deviceId)) {
    return res.status(400).json({ error: "subscription, and either (lat and lng) or deviceId, are required." });
  }

  const update = { endpoint: subscription.endpoint, keys: subscription.keys, lang: lang || "en" };
  if (hasLocation) { update.lat = lat; update.lng = lng; }
  if (deviceId) update.deviceId = deviceId;

  await PushSubscription.findOneAndUpdate(
    { endpoint: subscription.endpoint },
    update,
    { upsert: true, setDefaultsOnInsert: true }
  );
  res.json({ ok: true });
});

app.post("/unsubscribe", requireDb, async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: "endpoint is required." });

  await PushSubscription.deleteOne({ endpoint });
  res.json({ ok: true });
});

const WEATHER_ALERT_MESSAGES = {
  storm: {
    en: { title: "⛈️ Thunderstorm alert", body: "A thunderstorm is active at your location. Avoid fieldwork and spraying until it passes." },
    hi: { title: "⛈️ आंधी-तूफान चेतावनी", body: "आपके क्षेत्र में तूफान चल रहा है। इसके गुजरने तक खेत का काम और छिड़काव टालें।" },
    od: { title: "⛈️ ଝଡ଼ ସତର୍କତା", body: "ଆପଣଙ୍କ ଅଞ୍ଚଳରେ ଝଡ଼ ଚାଲିଛି। ଏହା ଶେଷ ନହେବା ପର୍ଯ୍ୟନ୍ତ ଚାଷ କାର୍ଯ୍ୟ ଓ ଛିଟା ଏଡାନ୍ତୁ।" },
    kn: { title: "⛈️ ಗುಡುಗು ಸಿಡಿಲಿನ ಎಚ್ಚರಿಕೆ", body: "ನಿಮ್ಮ ಪ್ರದೇಶದಲ್ಲಿ ಗುಡುಗು ಸಹಿತ ಮಳೆ ಇದೆ. ಅದು ಮುಗಿಯುವವರೆಗೆ ಹೊಲದ ಕೆಲಸ ಮತ್ತು ಸಿಂಪಡಣೆ ತಪ್ಪಿಸಿ." }
  },
  rain: {
    en: { title: "🌧️ Rain alert", body: "It's raining at your location right now. Delay spraying or harvesting until it clears up." },
    hi: { title: "🌧️ बारिश की चेतावनी", body: "आपके क्षेत्र में अभी बारिश हो रही है। छिड़काव या कटाई को मौसम साफ होने तक टालें।" },
    od: { title: "🌧️ ବର୍ଷା ସତର୍କତା", body: "ଆପଣଙ୍କ ଅଞ୍ଚଳରେ ବର୍ତ୍ତମାନ ବର୍ଷା ହେଉଛି। ପାଣି ସଫା ନହେବା ପର୍ଯ୍ୟନ୍ତ ଛିଟା କିମ୍ବା କଟାଣ ଏଡାନ୍ତୁ।" },
    kn: { title: "🌧️ ಮಳೆ ಎಚ್ಚರಿಕೆ", body: "ನಿಮ್ಮ ಪ್ರದೇಶದಲ್ಲಿ ಈಗ ಮಳೆ ಬರುತ್ತಿದೆ. ಹವಾಮಾನ ಸ್ವಚ್ಛವಾಗುವವರೆಗೆ ಸಿಂಪಡಣೆ ಅಥವಾ ಕೊಯ್ಲು ಮುಂದೂಡಿ." }
  },
  heat: {
    en: { title: "🥵 Extreme heat alert", body: "Temperature is very high at your location. Irrigate early morning or evening, and keep livestock shaded and hydrated." },
    hi: { title: "🥵 भीषण गर्मी की चेतावनी", body: "आपके क्षेत्र में तापमान बहुत अधिक है। सुबह या शाम सिंचाई करें, और पशुओं को छाया व पानी दें।" },
    od: { title: "🥵 ଅତ୍ୟଧିକ ଗରମ ସତର୍କତା", body: "ଆପଣଙ୍କ ଅଞ୍ଚଳରେ ତାପମାତ୍ରା ବହୁତ ଅଧିକ। ସକାଳ କିମ୍ବା ସନ୍ଧ୍ୟାରେ ପାଣି ଦିଅନ୍ତୁ, ଓ ପଶୁଙ୍କୁ ଛାୟା ଓ ପାଣି ଦିଅନ୍ତୁ।" },
    kn: { title: "🥵 ತೀವ್ರ ಬಿಸಿಲಿನ ಎಚ್ಚರಿಕೆ", body: "ನಿಮ್ಮ ಪ್ರದೇಶದಲ್ಲಿ ತಾಪಮಾನ ತುಂಬಾ ಹೆಚ್ಚಿದೆ. ಬೆಳಿಗ್ಗೆ ಅಥವಾ ಸಂಜೆ ನೀರಾವರಿ ಮಾಡಿ, ಜಾನುವಾರುಗಳಿಗೆ ನೆರಳು ಮತ್ತು ನೀರು ನೀಡಿ." }
  },
  frost: {
    en: { title: "❄️ Frost risk alert", body: "Temperature is near freezing at your location. Cover sensitive crops tonight to protect them from frost damage." },
    hi: { title: "❄️ पाला पड़ने की चेतावनी", body: "आपके क्षेत्र में तापमान जमाव बिंदु के करीब है। आज रात संवेदनशील फसलों को ढक दें।" },
    od: { title: "❄️ ପାଲା ସତର୍କତା", body: "ଆପଣଙ୍କ ଅଞ୍ଚଳରେ ତାପମାତ୍ରା ଜମାଟ ବିନ୍ଦୁ ନିକଟରେ। ଆଜି ରାତି ସମ୍ବେଦନଶୀଳ ଫସଲକୁ ଢାଙ୍କି ଦିଅନ୍ତୁ।" },
    kn: { title: "❄️ ಮಂಜುಗಡ್ಡೆಯ ಅಪಾಯದ ಎಚ್ಚರಿಕೆ", body: "ನಿಮ್ಮ ಪ್ರದೇಶದಲ್ಲಿ ತಾಪಮಾನ ಘನೀಕರಣ ಬಿಂದುವಿನ ಹತ್ತಿರವಿದೆ. ಸೂಕ್ಷ್ಮ ಬೆಳೆಗಳನ್ನು ಇಂದು ರಾತ್ರಿ ಮುಚ್ಚಿ." }
  }
};

function classifyWeather(data) {
  const weatherId = data.weather?.[0]?.id;
  const temp = data.main?.temp;
  if (typeof weatherId === "number" && weatherId < 300) return "storm";
  if (typeof weatherId === "number" && weatherId >= 500 && weatherId < 600) return "rain";
  if (typeof temp === "number" && temp >= 40) return "heat";
  if (typeof temp === "number" && temp <= 4) return "frost";
  return null;
}

async function checkWeatherAlerts() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  if (mongoose.connection.readyState !== 1) return;

  const subs = await PushSubscription.find();
  if (subs.length === 0) return;

  const today = new Date().toISOString().slice(0, 10);

  for (const sub of subs) {
    if (typeof sub.lat !== "number" || typeof sub.lng !== "number") continue; // sensor-only subscription, no location

    try {
      const url = `https://api.openweathermap.org/data/2.5/weather?lat=${sub.lat}&lon=${sub.lng}&appid=${OPENWEATHER_API_KEY}&units=metric`;
      const response = await fetch(url);
      if (!response.ok) continue;
      const data = await response.json();

      const type = classifyWeather(data);
      if (!type) continue;
      if (sub.lastAlerts?.get(type) === today) continue; // already alerted for this today

      const lang = WEATHER_ALERT_MESSAGES[type][sub.lang] ? sub.lang : "en";
      const { title, body } = WEATHER_ALERT_MESSAGES[type][lang];

      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify({ title, body }));
      sub.lastAlerts.set(type, today);
      await sub.save();
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        // subscription expired/gone — drop it
        await PushSubscription.deleteOne({ _id: sub._id });
      } else {
        console.error("Weather alert check failed:", err.message || err);
      }
    }
  }
}

const LOW_MOISTURE_THRESHOLD = 20; // percent

const SENSOR_ALERT_MESSAGES = {
  lowMoisture: {
    en: { title: "🚱 Low soil moisture", body: "Soil moisture is low at your monitored field. Consider irrigating soon." },
    hi: { title: "🚱 मिट्टी में नमी कम", body: "आपके निगरानी वाले खेत में मिट्टी की नमी कम है। जल्द सिंचाई करने पर विचार करें।" },
    od: { title: "🚱 ମାଟିରେ କମ୍ ଆର୍ଦ୍ରତା", body: "ଆପଣଙ୍କ ଖେତରେ ମାଟି ଆର୍ଦ୍ରତା କମ୍। ଶୀଘ୍ର ପାଣି ଦେବାକୁ ବିଚାର କରନ୍ତୁ।" },
    kn: { title: "🚱 ಮಣ್ಣಿನ ತೇವಾಂಶ ಕಡಿಮೆ", body: "ನಿಮ್ಮ ಗಮನಿಸುತ್ತಿರುವ ಹೊಲದಲ್ಲಿ ಮಣ್ಣಿನ ತೇವಾಂಶ ಕಡಿಮೆಯಿದೆ. ಶೀಘ್ರದಲ್ಲಿ ನೀರಾವರಿ ಮಾಡಿ." }
  }
};

async function checkSensorAlerts() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  if (mongoose.connection.readyState !== 1) return;

  const subs = await PushSubscription.find({ deviceId: { $exists: true, $ne: null } });
  if (subs.length === 0) return;

  const today = new Date().toISOString().slice(0, 10);

  for (const sub of subs) {
    try {
      const latest = await SensorReading.findOne({ deviceId: sub.deviceId }).sort({ createdAt: -1 });
      if (!latest || typeof latest.soilMoisture !== "number") continue;
      if (latest.soilMoisture >= LOW_MOISTURE_THRESHOLD) continue;
      if (sub.lastAlerts?.get("lowMoisture") === today) continue; // already alerted today

      const lang = SENSOR_ALERT_MESSAGES.lowMoisture[sub.lang] ? sub.lang : "en";
      const { title, body } = SENSOR_ALERT_MESSAGES.lowMoisture[lang];

      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify({ title, body }));
      sub.lastAlerts.set("lowMoisture", today);
      await sub.save();
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await PushSubscription.deleteOne({ _id: sub._id });
      } else {
        console.error("Sensor alert check failed:", err.message || err);
      }
    }
  }
}

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  cron.schedule("*/30 * * * *", checkWeatherAlerts);
  cron.schedule("*/30 * * * *", checkSensorAlerts);
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
