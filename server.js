/**
 * Servidor MCP — Ventas Mercado Libre para flo.
 *
 * Expone tools MCP que Claude/Cowork puede llamar para consultar
 * las ventas de la cuenta de vendedor de Mercado Libre.
 *
 * Endpoints:
 *   GET  /                      → página de estado
 *   GET  /auth                  → inicia la autorización OAuth con Mercado Libre (visitar 1 vez)
 *   GET  /oauth/callback        → recibe el code de ML y guarda los tokens
 *   POST /mcp/:secret           → endpoint MCP (usar esta URL como conector custom en Claude)
 *
 * Variables de entorno requeridas:
 *   ML_CLIENT_ID      App ID de tu aplicación en developers.mercadolibre.cl
 *   ML_CLIENT_SECRET  Secret Key de la aplicación
 *   BASE_URL          URL pública del servidor, sin slash final (ej: https://flo-ml.up.railway.app)
 *   MCP_SECRET        cadena aleatoria larga que protege el endpoint MCP
 * Opcionales:
 *   ML_AUTH_DOMAIN    default https://auth.mercadolibre.cl (Chile)
 *   DATA_DIR          default /data (montar volumen persistente aquí)
 *   PORT              default 3000
 */

import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const {
  ML_CLIENT_ID,
  ML_CLIENT_SECRET,
  BASE_URL,
  MCP_SECRET,
  ML_AUTH_DOMAIN = 'https://auth.mercadolibre.cl',
  DATA_DIR = '/data',
  PORT = 3000,
} = process.env;

for (const [k, v] of Object.entries({ ML_CLIENT_ID, ML_CLIENT_SECRET, BASE_URL, MCP_SECRET })) {
  if (!v) { console.error(`Falta la variable de entorno ${k}`); process.exit(1); }
}

const REDIRECT_URI = `${BASE_URL}/oauth/callback`;
const TOKENS_FILE = `${DATA_DIR}/tokens.json`;

// ---------- persistencia de tokens ----------
let tokens = null; // { access_token, refresh_token, expires_at, user_id }
try { tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch { tokens = null; }
function saveTokens(t) {
  tokens = t;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2));
  } catch (e) { console.error('No se pudo guardar tokens:', e.message); }
}

// ---------- OAuth Mercado Libre ----------
async function tokenRequest(params) {
  const res = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OAuth ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

let refreshing = null; // evita refresh en paralelo (los refresh tokens de ML son de un solo uso)
async function ensureAccessToken() {
  if (!tokens) throw new Error(`Cuenta ML no autorizada aún. Abre ${BASE_URL}/auth en el navegador y autoriza.`);
  if (Date.now() < (tokens.expires_at || 0) - 120000) return tokens.access_token;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const d = await tokenRequest({
          grant_type: 'refresh_token',
          client_id: ML_CLIENT_ID,
          client_secret: ML_CLIENT_SECRET,
          refresh_token: tokens.refresh_token,
        });
        saveTokens({
          ...tokens,
          access_token: d.access_token,
          refresh_token: d.refresh_token || tokens.refresh_token,
          expires_at: Date.now() + d.expires_in * 1000,
        });
      } finally { refreshing = null; }
    })();
  }
  await refreshing;
  return tokens.access_token;
}

async function mlGet(path) {
  const at = await ensureAccessToken();
  const res = await fetch(`https://api.mercadolibre.com${path}`, {
    headers: { authorization: `Bearer ${at}`, accept: 'application/json' },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`ML API ${res.status} en ${path.split('?')[0]}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function sellerId() {
  if (tokens?.user_id) return tokens.user_id;
  const me = await mlGet('/users/me');
  saveTokens({ ...tokens, user_id: me.id });
  return me.id;
}

// ---------- consultas de ventas ----------
// Suma órdenes pagadas en un rango. Zona horaria Chile aproximada con offset fijo -04:00.
async function ventasRango(fromISO, toISO) {
  const id = await sellerId();
  let offset = 0, total = 0, ordenes = 0;
  while (offset < 1000) { // tope de seguridad
    const q = new URLSearchParams({
      seller: String(id),
      'order.status': 'paid',
      'order.date_created.from': fromISO,
      'order.date_created.to': toISO,
      sort: 'date_asc',
      limit: '50',
      offset: String(offset),
    });
    const r = await mlGet(`/orders/search?${q}`);
    const results = r.results || [];
    for (const o of results) {
      total += Number(o.paid_amount ?? o.total_amount ?? 0);
      ordenes += 1;
    }
    offset += 50;
    if (results.length < 50 || offset >= (r.paging?.total ?? 0)) break;
  }
  return { total: Math.round(total), ordenes };
}

function rangoMes(anio, mes /* 1-12 */) {
  const from = `${anio}-${String(mes).padStart(2, '0')}-01T00:00:00.000-04:00`;
  const next = mes === 12 ? `${anio + 1}-01-01` : `${anio}-${String(mes + 1).padStart(2, '0')}-01`;
  return { from, to: `${next}T00:00:00.000-04:00` };
}

// ---------- servidor MCP ----------
function buildMcpServer() {
  const server = new McpServer({ name: 'mercadolibre-flo', version: '1.0.0' });

  server.registerTool('ml_estado', {
    description: 'Estado de la conexión con Mercado Libre: si la cuenta está autorizada y qué user_id de vendedor se usa.',
    inputSchema: {},
  }, async () => {
    const info = tokens
      ? { autorizado: true, user_id: tokens.user_id ?? '(se obtiene en la primera consulta)', token_expira: new Date(tokens.expires_at || 0).toISOString() }
      : { autorizado: false, instruccion: `Abrir ${BASE_URL}/auth y autorizar la cuenta vendedora de flo.` };
    return { content: [{ type: 'text', text: JSON.stringify(info) }] };
  });

  server.registerTool('ml_ventas_mensuales', {
    description: 'Ventas de Mercado Libre agregadas por mes (órdenes pagadas, monto en CLP). Devuelve [{mes:"YYYY-MM", total, ordenes}]. Usar para llenar dashboards de venta mensual.',
    inputSchema: {
      desde: z.string().regex(/^\d{4}-\d{2}$/).describe('Mes inicial, formato YYYY-MM, ej 2026-01'),
      hasta: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('Mes final inclusive, default: mes actual'),
    },
  }, async ({ desde, hasta }) => {
    const now = new Date();
    const hastaStr = hasta || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const [y1, m1] = desde.split('-').map(Number);
    const [y2, m2] = hastaStr.split('-').map(Number);
    const meses = [];
    for (let y = y1, m = m1; y < y2 || (y === y2 && m <= m2); m === 12 ? (y++, m = 1) : m++) {
      const { from, to } = rangoMes(y, m);
      const { total, ordenes } = await ventasRango(from, to);
      meses.push({ mes: `${y}-${String(m).padStart(2, '0')}`, total, ordenes });
    }
    return { content: [{ type: 'text', text: JSON.stringify({ moneda: 'CLP', criterio: 'órdenes pagadas por fecha de creación', meses }) }] };
  });

  server.registerTool('ml_ordenes_recientes', {
    description: 'Lista simplificada de las órdenes pagadas de los últimos N días en Mercado Libre (fecha, monto, productos).',
    inputSchema: {
      dias: z.number().int().min(1).max(90).optional().describe('Días hacia atrás, default 30'),
    },
  }, async ({ dias = 30 }) => {
    const id = await sellerId();
    const from = new Date(Date.now() - dias * 86400000).toISOString();
    const q = new URLSearchParams({
      seller: String(id), 'order.status': 'paid',
      'order.date_created.from': from, sort: 'date_desc', limit: '50',
    });
    const r = await mlGet(`/orders/search?${q}`);
    const ordenes = (r.results || []).map(o => ({
      fecha: o.date_created,
      total: o.paid_amount ?? o.total_amount,
      estado: o.status,
      productos: (o.order_items || []).map(i => `${i.item?.title} x${i.quantity}`),
    }));
    return { content: [{ type: 'text', text: JSON.stringify({ dias, cantidad: ordenes.length, ordenes }) }] };
  });

  return server;
}

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.type('html').send(`<h2>flo. × Mercado Libre MCP</h2>
    <p>Estado: ${tokens ? '✅ cuenta autorizada' : `❌ sin autorizar — <a href="/auth">autorizar ahora</a>`}</p>
    <p>Endpoint MCP: <code>POST ${BASE_URL}/mcp/&lt;secret&gt;</code></p>`);
});

app.get('/auth', (_req, res) => {
  const state = crypto.randomBytes(8).toString('hex');
  const u = new URL(`${ML_AUTH_DOMAIN}/authorization`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', ML_CLIENT_ID);
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  u.searchParams.set('state', state);
  res.redirect(u.toString());
});

app.get('/oauth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Falta ?code');
    const d = await tokenRequest({
      grant_type: 'authorization_code',
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
    });
    saveTokens({
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_at: Date.now() + d.expires_in * 1000,
      user_id: d.user_id,
    });
    res.type('html').send('<h2>✅ Cuenta de Mercado Libre autorizada</h2><p>Ya puedes cerrar esta pestaña y volver a Claude.</p>');
  } catch (e) {
    res.status(500).type('html').send(`<h2>Error en la autorización</h2><pre>${e.message}</pre>`);
  }
});

// Endpoint MCP (stateless: una instancia por request)
app.post('/mcp/:secret', async (req, res) => {
  if (req.params.secret !== MCP_SECRET) return res.status(401).json({ error: 'unauthorized' });
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('MCP error:', e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});
app.get('/mcp/:secret', (_req, res) => res.status(405).json({ error: 'Use POST (servidor stateless)' }));
app.delete('/mcp/:secret', (_req, res) => res.status(405).json({ error: 'Use POST (servidor stateless)' }));

app.listen(PORT, () => console.log(`flo. ML MCP escuchando en :${PORT} — auth en ${BASE_URL}/auth`));
