// netlify/functions/shopify-webhook.js
// Recibe el aviso automático de Shopify cuando entra un pedido nuevo,
// lo interpreta y lo guarda en Firebase con el mismo formato que usa la app.

const crypto = require('crypto');
const https = require('https');

const FIREBASE_DB = 'https://tienda-total-py-default-rtdb.firebaseio.com';
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

function verificarFirma(rawBody, hmacHeader) {
  if (!SHOPIFY_WEBHOOK_SECRET || !hmacHeader) return false;
  const hash = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET).update(rawBody, 'utf8').digest('base64');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmacHeader));
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data || 'null')); } catch (e) { resolve(null); } });
    }).on('error', reject);
  });
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

function today() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Asuncion' }); }
function addDays(d, n) { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); }
function calcFechaEntrega(fecha) {
  const horaPY = new Date().toLocaleString('en-US', { timeZone: 'America/Asuncion', hour: '2-digit', hour12: false });
  const hora = parseInt(horaPY, 10);
  return hora < 13 ? fecha : addDays(fecha, 1);
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function normalizar(s) { return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim(); }

exports.handler = async (event) => {
  try {
    const hmac = event.headers['x-shopify-hmac-sha256'] || event.headers['X-Shopify-Hmac-Sha256'];
    if (!verificarFirma(event.body, hmac)) {
      return { statusCode: 401, body: 'Firma inválida' };
    }
    const order = JSON.parse(event.body);

    // Traer catálogo actual para matchear productos por nombre
    const productosRaw = await fetchJSON(`${FIREBASE_DB}/productos.json`);
    const productos = productosRaw ? Object.values(productosRaw) : [];

    const arts = (order.line_items || []).map(li => {
      const tituloNorm = normalizar(li.title || '');
      const match = productos
        .filter(p => p.nombre)
        .sort((a, b) => normalizar(b.nombre).length - normalizar(a.nombre).length)
        .find(p => tituloNorm.includes(normalizar(p.nombre)));
      const varianteTxt = normalizar(li.variant_title || '');
      let vid = '', vnom = li.variant_title || '';
      if (match && match.variantes && match.variantes.length) {
        const vMatch = match.variantes.find(v => v.color && varianteTxt.includes(normalizar(v.color)));
        const v = vMatch || match.variantes[0];
        vid = v.id; vnom = v.color || vnom;
      }
      return {
        pid: match ? match.id : '',
        nombre: match ? match.nombre : (li.title || 'Producto Shopify'),
        img: match ? (match.img || '') : '',
        vid, vnom,
        cant: li.quantity || 1,
        precio: match ? match.precio : parseFloat(li.price || 0)
      };
    });

    const resumen = arts.map(a => `${a.nombre}${a.vnom ? ' (' + a.vnom + ')' : ''} x${a.cant}`).join(', ');
    const fecha = today();
    const fechaEntrega = calcFechaEntrega(fecha);

    // Número de pedido correlativo (igual que cuando lo cargás a mano)
    const pedidosRaw = await fetchJSON(`${FIREBASE_DB}/pedidos.json`);
    const pedidos = pedidosRaw ? Object.values(pedidosRaw) : [];
    const numero = pedidos.reduce((m, p) => Math.max(m, p.numero || 0), 999) + 1;

    const cliente = order.customer
      ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim()
      : (order.shipping_address?.name || 'Cliente Shopify');
    const telefono = order.phone || order.customer?.phone || order.shipping_address?.phone || '';
    const ciudad = order.shipping_address?.city || '';
    const nota = order.shipping_address
      ? `${order.shipping_address.address1 || ''} ${order.shipping_address.address2 || ''}`.trim()
      : '';
    const montoFinal = parseFloat(order.total_price || 0);

    const id = uid();
    const pedido = {
      id, fecha, fechaEntrega, numero, cliente, telefono, ciudad, nota,
      arts, resumen, montoFinal, estado: 'tomado',
      origen: 'shopify', shopifyOrderId: order.id
    };

    await putJSON(`${FIREBASE_DB}/pedidos/${id}.json`, pedido);
    // Aviso para que la app muestre la notificación
    await putJSON(`${FIREBASE_DB}/notificaciones/${id}.json`, {
      id, pedidoId: id, numero, cliente, montoFinal,
      fecha: new Date().toISOString(), leido: false
    });

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: 'Error: ' + err.message };
  }
};
      
