// proxy.js — Node.js + Express
// Supporte NVIDIA NIM et Groq via un seul endpoint /api/chat
// Variables d'env requises sur la plateforme d'hébergement :
//   NVIDIA_API_KEY=nvapi-xxxxxxxxxxxx   (optionnel)
//   GROQ_API_KEY=gsk_xxxxxxxxxxxx        (optionnel)
//   Au moins une des deux est requise.

import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors({ origin: '*' })); // ⚠ Restreindre à votre domaine en production
app.use(express.json({ limit: '10mb' }));

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

if (!NVIDIA_API_KEY && !GROQ_API_KEY) {
  console.error('[FATAL] Aucune clé API. Définissez NVIDIA_API_KEY et/ou GROQ_API_KEY.');
  process.exit(1);
}

console.log('✓ Clés chargées :');
console.log('  NVIDIA :', NVIDIA_API_KEY ? 'configurée' : 'absente');
console.log('  Groq   :', GROQ_API_KEY ? 'configurée' : 'absente');

// Endpoints upstream (tous deux compatibles OpenAI)
const PROVIDERS = {
  nvidia: {
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    key: NVIDIA_API_KEY,
    label: 'NVIDIA NIM'
  },
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    key: GROQ_API_KEY,
    label: 'Groq Cloud'
  }
};

// Rate limit simple
const rateBuckets = new Map();
const RATE_LIMIT = 40;
const RATE_WINDOW = 60000;

function checkRate(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || { count: 0, reset: now + RATE_WINDOW };
  if (now > bucket.reset) { bucket.count = 0; bucket.reset = now + RATE_WINDOW; }
  bucket.count++;
  rateBuckets.set(ip, bucket);
  return bucket.count <= RATE_LIMIT;
}

// Liste des fournisseurs disponibles
app.get('/api/providers', (_, res) => {
  res.json({
    nvidia: { available: !!NVIDIA_API_KEY, label: 'NVIDIA NIM' },
    groq: { available: !!GROQ_API_KEY, label: 'Groq Cloud' }
  });
});

// Endpoint générique
app.post('/api/chat', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkRate(ip)) {
    return res.status(429).json({ error: 'Rate limit : trop de requêtes. Attendez 1 minute.' });
  }

  try {
    const { provider = 'nvidia', model, messages, temperature, max_tokens, response_format } = req.body;

    if (!model || !messages) {
      return res.status(400).json({ error: 'model et messages requis' });
    }

    const prov = PROVIDERS[provider];
    if (!prov) {
      return res.status(400).json({ error: `Fournisseur inconnu : ${provider}` });
    }
    if (!prov.key) {
      return res.status(400).json({ error: `Clé ${provider} absente côté serveur. Ajoutez ${provider.toUpperCase()}_API_KEY.` });
    }

    const payload = {
      model,
      messages,
      temperature: temperature ?? 0.1,
      max_tokens: max_tokens ?? 2048,
      stream: false
    };
    if (response_format) payload.response_format = response_format;

    const upstream = await fetch(prov.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${prov.key}`
      },
      body: JSON.stringify(payload)
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error(`[${prov.label} ERROR]`, upstream.status, errText.slice(0, 500));
      return res.status(upstream.status).json({
        error: `${prov.label} ${upstream.status}`,
        details: errText.slice(0, 500)
      });
    }

    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    console.error('[PROXY ERROR]', err);
    res.status(500).json({ error: 'Proxy error', details: err.message });
  }
});

// Compat : anciens appels /api/nvidia/chat continuent de fonctionner
app.post('/api/nvidia/chat', (req, res, next) => {
  req.body.provider = 'nvidia';
  req.url = '/api/chat';
  app._router.handle(req, res, next);
});

app.get('/api/health', (_, res) => res.json({
  ok: true,
  service: 'marge-proxy-v4.1',
  providers: {
    nvidia: !!NVIDIA_API_KEY,
    groq: !!GROQ_API_KEY
  }
}));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`✓ Proxy MARGE v4.1 sur le port ${PORT}`);
});