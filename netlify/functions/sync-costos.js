// netlify/functions/sync-costos.js
// Corre solo cada 10 minutos (ver netlify.toml). Lee el "costo por artículo" que está
// cargado en Shopify y lo copia al campo costo de cada producto de la app (Firebase),
// recalculando el margen. No toca el stock ni ningún otro dato.
// Los combos (productos con componentes) se saltan: su costo se arma desde sus componentes.

const https = require('https');

const SHOP = '2seg9c-gn.myshopify.com';
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = '2026-07';
const FIREBASE_DB = 'https://tienda-total-py-default-rtdb.firebaseio.com';

function request(options, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(options, res => {
      let resp = '';
      res.on('data', c => resp += c);
      res.on('end', () => {
        try { resolve(JSON.parse(resp || 'null')); } catch (e) { resolve(null); }
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function pedirToken() {
  const data = `client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`;
  return request({
    hostname: SHOP, path: '/admin/oauth/access_token', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
  }, data).then(j => {
    if (j && j.access_token) return j.access_token;
    throw new Error('Sin access_token: ' + JSON.stringify(j));
  });
}

function graphql(token, query, variables) {
  const data = JSON.stringify({ query, variables });
  return request({
    hostname: SHOP, path: `/admin/api/${API_VERSION}/graphql.json`, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token, 'Content-Length': Buffer.byteLength(data) }
  }, data);
}

function firebase(method, path, body) {
  const data = body ? JSON.stringify(body) : null;
  const u = new URL(FIREBASE_DB + path);
  const headers = { 'Content-Type': 'application/json' };
  if (data) headers['Content-Length'] = Buffer.byteLength(data);
  return request({ hostname: u.hostname, path: u.pathname + u.search, method, headers }, data);
}

const QUERY = `query($after: String){
  products(first: 50, after: $after){
    pageInfo{ hasNextPage endCursor }
    nodes{ id variants(first: 100){ nodes{ inventoryItem{ unitCost{ amount } } } } }
  }
}`;

exports.handler = async () => {
  try {
    const token = await pedirToken();

    // costo por id numérico de producto de Shopify
    const costos = {};
    let after = null;
    for (let i = 0; i < 20; i++) {
      const r = await graphql(token, QUERY, { after });
      if (!r || r.errors || !r.data) throw new Error('Error leyendo Shopify: ' + JSON.stringify(r && r.errors));
      const page = r.data.products;
      for (const p of page.nodes) {
        const idNum = String(p.id).split('/').pop();
        const c = p.variants.nodes
          .map(v => v.inventoryItem && v.inventoryItem.unitCost ? parseFloat(v.inventoryItem.unitCost.amount) : 0)
          .find(x => x > 0);
        if (c) costos[idNum] = Math.round(c);
      }
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }

    const todos = await firebase('GET', '/productos.json');
    if (!todos) return { statusCode: 200, body: 'Sin productos' };

    let cambiados = 0;
    for (const [key, p] of Object.entries(todos)) {
      if (!p || !p.shopifyProductId || p.componentes) continue;
      const nuevo = costos[String(p.shopifyProductId)];
      if (!nuevo || nuevo === p.costo) continue;
      const precio = p.precio || 0;
      const margen = precio > 0 ? Math.round((precio - nuevo) / precio * 100) : 0;
      await firebase('PATCH', `/productos/${key}.json`, { costo: nuevo, margen });
      cambiados++;
    }
    console.log('sync-costos OK, productos actualizados:', cambiados);
    await firebase('PUT', '/debugSyncCostos.json', { hora: new Date().toISOString(), ok: true, actualizados: cambiados }).catch(() => {});
    return { statusCode: 200, body: 'OK ' + cambiados };
  } catch (err) {
    console.error('sync-costos ERROR', err);
    await firebase('PUT', '/debugSyncCostos.json', { hora: new Date().toISOString(), error: String(err.message || err).slice(0, 500) }).catch(() => {});
    return { statusCode: 500, body: 'Error: ' + err.message };
  }
};
