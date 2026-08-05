// netlify/functions/shopify-sku-sync.js
// Recibe desde la app: { shopifyProductId, skuViejo, skuNuevo }
// Pide un token a Shopify (client credentials), busca la variante por su SKU viejo,
// y le actualiza el SKU al nuevo. Así el SKU queda igual en la app y en Shopify.

const https = require('https');

const SHOP = '2seg9c-gn.myshopify.com';
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = '2024-10';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-Shopify-Access-Token'] = token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = https.request({ hostname: SHOP, path, method, headers }, res => {
      let resp = '';
      res.on('data', c => resp += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(resp || '{}') }); }
        catch (e) { resolve({ status: res.statusCode, json: {} }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function pedirToken() {
  return new Promise((resolve, reject) => {
    const data = `client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`;
    const r = https.request({
      hostname: SHOP,
      path: '/admin/oauth/access_token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let resp = '';
      res.on('data', c => resp += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(resp);
          if (j.access_token) resolve(j.access_token);
          else reject(new Error('Sin access_token: ' + resp));
        } catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: 'Solo POST' };
  }
  try {
    const { shopifyProductId, skuViejo, skuNuevo } = JSON.parse(event.body || '{}');
    if (!shopifyProductId || !skuNuevo) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'Faltan datos' }) };
    }

    const token = await pedirToken();

    // Buscar el producto y su variante por el SKU viejo
    const prodResp = await req('GET', `/admin/api/${API_VERSION}/products/${shopifyProductId}.json`, token);
    if (prodResp.status !== 200 || !prodResp.json.product) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ ok: false, error: 'Producto no encontrado en Shopify' }) };
    }
    const variants = prodResp.json.product.variants || [];
    let variant = variants.find(v => (v.sku || '') === (skuViejo || ''));
    // Si no hay match por SKU viejo y el producto tiene una sola variante, usar esa
    if (!variant && variants.length === 1) variant = variants[0];
    if (!variant) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ ok: false, error: 'Variante no encontrada (SKU viejo no coincide)' }) };
    }

    const updResp = await req('PUT', `/admin/api/${API_VERSION}/variants/${variant.id}.json`, token, {
      variant: { id: variant.id, sku: skuNuevo }
    });
    if (updResp.status !== 200) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: 'Shopify rechazó el cambio', detalle: updResp.json }) };
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
