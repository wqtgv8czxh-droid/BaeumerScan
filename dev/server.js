const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 8080;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const EDGES_MODEL = process.env.CLAUDE_EDGES_MODEL || 'claude-haiku-4-5-20251001';
const DEV_AUTH_EMAIL = process.env.DEV_AUTH_EMAIL || '';
const DEV_AUTH_PASSWORD = process.env.DEV_AUTH_PASSWORD || '';
const PUBLIC_DIR = path.resolve(__dirname, 'public');

if (!ANTHROPIC_KEY) {
  console.error('FEHLER: ANTHROPIC_API_KEY ist nicht gesetzt');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const ANALYSIS_PROMPT = `Du bist ein präziser deutschsprachiger Dokumenten-Analyst für ein privates Familien-Dokumentenarchiv. Lese das Bild sorgfältig und extrahiere strukturierte Daten.

REGELN:
- Antworte AUSSCHLIESSLICH mit gültigem JSON-Objekt — kein Markdown, keine Einleitung, keine Erklärung
- Bei unsicheren oder fehlenden Werten: null verwenden, niemals raten
- Deutsche Zahlenformate normalisieren: "1.234,56" → 1234.56
- Datumsangaben immer als YYYY-MM-DD

FELDER:
- text: Vollständiger Volltext des Dokuments. Zeilenumbrüche als \\n. Originalsprache erhalten.
- titel: Prägnant, max 60 Zeichen. Startet mit der Dokumentart und enthält den wichtigsten Identifikator. Beispiele: "Rechnung Vodafone 11/2025", "Mietvertrag Hamburg Eppendorf", "Versicherungspolice HUK24 KFZ".
- typ: Genau einer von "Rechnung", "Vertrag", "Allgemein".
- datum: Hauptdatum (Rechnungsdatum, Vertragsdatum, Ausstellungsdatum).
- betrag: Gesamtbetrag / Endsumme als Zahl (Punkt als Dezimaltrenner). Bei Verträgen ohne klare Endsumme: null.
- waehrung: ISO-Code (EUR, USD, CHF, …). Default EUR wenn unklar.
- tags: 2-5 spezifische Tags: Anbieter/Absender (z.B. "Vodafone"), Kategorie (z.B. "Mobilfunk", "Strom", "Miete"), ggf. Rechnungs- oder Vertragsnummer.

JSON-SCHEMA:
{"text": string, "titel": string, "typ": "Rechnung"|"Vertrag"|"Allgemein", "datum": string|null, "betrag": number|null, "waehrung": string, "tags": string[]}`;

const EDGES_PROMPT = `Du analysierst ein Foto, das ein Dokument enthält (Papier, Rechnung, Vertrag, Brief, Karte, Ausweis).

AUFGABE: Identifiziere das Hauptdokument und gib seine achsen-parallele Bounding Box im Bild zurück.

ANTWORTFORMAT: AUSSCHLIESSLICH JSON, ohne Markdown, ohne Erklärungen:
{"x": number, "y": number, "w": number, "h": number, "confidence": "high"|"medium"|"low"}

REGELN:
- Alle Werte als Prozent der Bilddimensionen (0 = linker/oberer Rand, 100 = rechter/unterer Rand)
- x, y: Position der linken oberen Ecke des Dokuments
- w, h: Breite und Höhe des Dokuments
- Box leicht großzügig (~2-5% Rand außen ok), aber Hintergrund/Tischplatte ausschließen
- Bei rotiertem Dokument: die enge umschließende achsenparallele Box wählen
- confidence: "high" bei klaren Kanten, "medium" bei teilweise verdeckt, "low" wenn unsicher
- Wenn KEIN Dokument erkennbar: {"x":5,"y":5,"w":90,"h":90,"confidence":"low"}`;

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

async function callAnthropic({ model, system, images, prompt, maxTokens }) {
  const content = [];
  images.forEach((img, idx) => {
    if (images.length > 1) {
      content.push({ type: 'text', text: `Seite ${idx + 1}:` });
    }
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mediaType || 'image/jpeg',
        data: img.data,
      },
    });
  });
  content.push({ type: 'text', text: prompt });

  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
    }),
  });
}

function normalizeImages(payload) {
  if (Array.isArray(payload.imagesBase64) && payload.imagesBase64.length > 0) {
    return payload.imagesBase64.map((img) =>
      typeof img === 'string'
        ? { data: img, mediaType: payload.mediaType || 'image/jpeg' }
        : { data: img.data, mediaType: img.mediaType || 'image/jpeg' }
    );
  }
  if (payload.imageBase64) {
    return [{ data: payload.imageBase64, mediaType: payload.mediaType || 'image/jpeg' }];
  }
  return [];
}

function logUsage(label, data) {
  if (!data.usage) return;
  const u = data.usage;
  console.log(
    `[${label}] in=${u.input_tokens} out=${u.output_tokens}` +
      (u.cache_read_input_tokens ? ` cache_read=${u.cache_read_input_tokens}` : '') +
      (u.cache_creation_input_tokens ? ` cache_create=${u.cache_creation_input_tokens}` : '')
  );
}

async function handleClaudeProxy(req, res) {
  try {
    const payload = await readJsonBody(req);
    const images = normalizeImages(payload);
    if (images.length === 0) throw new Error('Kein Bild übergeben');

    const prompt =
      images.length > 1
        ? `Dieses Dokument hat ${images.length} Seiten. Analysiere alle Seiten zusammen als ein zusammenhängendes Dokument und fülle das JSON aus. Das Feld "text" enthält den Volltext aller Seiten, mit "\\n--- Seite N ---\\n" als Trenner.`
        : 'Analysiere dieses Dokument und fülle das JSON aus.';

    const apiRes = await callAnthropic({
      model: MODEL,
      system: ANALYSIS_PROMPT,
      images,
      prompt,
      maxTokens: 4000,
    });

    const data = await apiRes.json();
    logUsage(`analysis(${images.length}p)`, data);
    res.writeHead(apiRes.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (err) {
    console.error('[claude-proxy] Fehler:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleDetectEdges(req, res) {
  try {
    const payload = await readJsonBody(req);
    const images = normalizeImages(payload);
    if (images.length === 0) throw new Error('Kein Bild übergeben');

    const apiRes = await callAnthropic({
      model: EDGES_MODEL,
      system: EDGES_PROMPT,
      images: [images[0]],
      prompt: 'Gib die Bounding Box des Dokuments zurück.',
      maxTokens: 150,
    });

    const data = await apiRes.json();
    logUsage('edges', data);

    const raw = data.content?.[0]?.text || '';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    let bbox = null;
    try {
      bbox = JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) bbox = JSON.parse(match[0]);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ bbox, usage: data.usage }));
  } catch (err) {
    console.error('[detect-edges] Fehler:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

function handleDevConfig(req, res) {
  const body = {
    devAuth:
      DEV_AUTH_EMAIL && DEV_AUTH_PASSWORD
        ? { email: DEV_AUTH_EMAIL, password: DEV_AUTH_PASSWORD }
        : null,
  };
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  filePath = path.join(PUBLIC_DIR, filePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url.startsWith('/functions/v1/claude-proxy') && req.method === 'POST') {
    return handleClaudeProxy(req, res);
  }
  if (req.url.startsWith('/functions/v1/claude-detect-edges') && req.method === 'POST') {
    return handleDetectEdges(req, res);
  }
  if (req.url.startsWith('/dev-config.json') && req.method === 'GET') {
    return handleDevConfig(req, res);
  }

  if (req.method === 'GET') return serveStatic(req, res);

  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`Dev-Server läuft auf http://localhost:${PORT}`);
  console.log(`Analyse-Modell: ${MODEL}`);
  console.log(`Edge-Detection-Modell: ${EDGES_MODEL}`);
  console.log(`Auto-Login: ${DEV_AUTH_EMAIL ? 'aktiv (' + DEV_AUTH_EMAIL + ')' : 'inaktiv'}`);
});
