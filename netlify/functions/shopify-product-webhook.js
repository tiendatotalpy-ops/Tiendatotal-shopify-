// netlify/functions/shopify-product-webhook.js
// Recibe el aviso de Shopify cuando se CREA un producto nuevo,
// y lo agrega automáticamente al catálogo de la app (Firebase).

const crypto = require('crypto');
const https = require('https');

const FIREBASE_DB = 'https://tienda-total-py-default-rtdb.firebaseio.com';
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

function verificarFirma(rawBody, hmacHeader) {
  if (!SHOPIFY_WEBHOOK_SECRET || !hmacHeader) return false;
  const hash = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET).update(rawBody, 'utf8').digest('base64');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmacHeader));
}

function putJSON(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let resp = '';
      res.on('data', c => resp += c);
      res.on('end', () => resolve(resp));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

exports.handler = async (event) => {
  try {
    const hmac = event.headers['x-shopify-hmac-sha256'] || event.headers['X-Shopify-Hmac-Sha256'];
    if (!verificarFirma(event.body, hmac)) {
      return { statusCode: 401, body: 'Firma inválida' };
    }
    const prod = JSON.parse(event.body);

    const img = (prod.image && prod.image.src) || (prod.images && prod.images[0] && prod.images[0].src) || '';
    const variantsShopify = prod.variants || [];

    // Si tiene más de una variante (o una variante con nombre distinto de "Default Title"),
    // se cargan como colores/variantes en la app. Si no, es un producto simple.
    const tieneVariantesReales = variantsShopify.length > 1 ||
      (variantsShopify.length === 1 && variantsShopify[0].title && variantsShopify[0].title !== 'Default Title');

    const variantes = tieneVariantesReales
      ? variantsShopify.map(v => ({
          id: uid(),
          color: v.title || '',
          hex: '#7ed957',
          stock: v.inventory_quantity || 0,
          codigo: v.sku || ''
        }))
      : [];

    const precio = parseFloat((variantsShopify[0] && variantsShopify[0].price) || 0);
    const stockBase = tieneVariantesReales ? 0 : (variantsShopify[0] ? (variantsShopify[0].inventory_quantity || 0) : 0);
    const codigoProducto = (!tieneVariantesReales && variantsShopify[0]) ? (variantsShopify[0].sku || '') : '';

    const producto = {
      nombre: prod.title || 'Producto sin nombre',
      codigo: codigoProducto,
      proveedor: '',
      precio,
      costo: 0,
      margen: 0,
      img,
      variantes,
      stock: stockBase,
      origen: 'shopify',
      shopifyProductId: prod.id
    };

    const id = uid();
    producto.id = id;
    await putJSON(`${FIREBASE_DB}/productos/${id}.json`, producto);

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: 'Error: ' + err.message };
  }
};
