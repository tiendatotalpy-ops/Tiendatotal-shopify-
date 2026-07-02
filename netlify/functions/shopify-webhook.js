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
function esDomingo(d) { return new Date(d + 'T00:00:00').getDay() === 0; }
function calcFechaEntrega(fecha) {
  const horaPY = new Date().toLocaleString('en-US', { timeZone: 'America/Asuncion', hour: '2-digit', hour12: false });
  const hora = parseInt(horaPY, 10);
  let fe = hora < 13 ? fecha : addDays(fecha, 1);
  if (esDomingo(fe)) fe = addDays(fe, 1); // el delivery no trabaja domingo, pasa directo al lunes
  return fe;
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function normalizar(s) { return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim(); }

// Incremento atómico del contador de pedidos: Firebase resuelve esto en el servidor
// usando el valor especial {".sv": {"increment": N}}, así nunca se repite un número
// aunque la app (a mano) y esta función (Shopify) pidan "el próximo número" a la vez.
async function siguienteNumeroAtomico() {
  const resp = await fetch(`${FIREBASE_DB}/contadores/pedidoNumero.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ '.sv': { increment: 1 } })
  });
  const nuevoValor = await resp.json();
  return typeof nuevoValor === 'number' ? nuevoValor : null;
}

exports.handler = async (event) => {
  try {
    const hmac = event.headers['x-shopify-hmac-sha256'] || event.headers['X-Shopify-Hmac-Sha256'];
    if (!verificarFirma(event.body, hmac)) {
      return { statusCode: 401, body: 'Firma inválida' };
    }
    const order = JSON.parse(event.body);

    // Traer catálogo actual para matchear: cada SKU ahora vive en la VARIANTE (color),
    // no en el producto general. Armamos un mapa código → {producto, variante} para
    // poder encontrar exacto a qué color corresponde cada línea del pedido de Shopify.
    const productosRaw = await fetchJSON(`${FIREBASE_DB}/productos.json`);
    const productos = productosRaw ? Object.values(productosRaw) : [];
    const porCodigoVariante = {};
    const porCodigoProducto = {};
    productos.forEach(p => {
      if (p.codigo) porCodigoProducto[normalizar(p.codigo)] = p;
      (p.variantes || []).forEach(v => {
        if (v.codigo) porCodigoVariante[normalizar(v.codigo)] = { producto: p, variante: v };
      });
    });

    const arts = (order.line_items || []).map(li => {
      const skuNorm = normalizar(li.sku || '');
      console.log(`SKU Shopify: "${li.sku}" → normalizado: "${skuNorm}" | título: "${li.title}"`);
      console.log('SKUs en catálogo por variante:', Object.keys(porCodigoVariante));
      console.log('SKUs en catálogo por producto:', Object.keys(porCodigoProducto));
      let match = null, vid = '', vnom = li.variant_title || '';

      if (skuNorm && porCodigoVariante[skuNorm]) {
        // Coincidencia exacta por SKU de variante (lo más confiable)
        match = porCodigoVariante[skuNorm].producto;
        vid = porCodigoVariante[skuNorm].variante.id;
        vnom = porCodigoVariante[skuNorm].variante.color || vnom;
      } else if (skuNorm && porCodigoProducto[skuNorm]) {
        // SKU a nivel producto (productos sin variantes de color)
        match = porCodigoProducto[skuNorm];
      } else {
        // Respaldo: buscar por nombre si no hubo coincidencia exacta de SKU
        const tituloNorm = normalizar(li.title || '');
        match = productos
          .filter(p => p.nombre)
          .sort((a, b) => normalizar(b.nombre).length - normalizar(a.nombre).length)
          .find(p => tituloNorm.includes(normalizar(p.nombre)));
        if (match && match.variantes && match.variantes.length) {
          const varianteTxt = normalizar(li.variant_title || '');
          const vMatch = match.variantes.find(v => v.color && varianteTxt.includes(normalizar(v.color)));
          const v = vMatch || match.variantes[0];
          vid = v.id; vnom = v.color || vnom;
        }
      }

      return {
        pid: match ? match.id : '',
        nombre: match ? match.nombre : (li.title || 'Producto Shopify'),
        img: match ? (match.img || '') : '',
        vid, vnom,
        cant: li.quantity || 1,
        precio: match ? match.precio : parseFloat(li.price || 0),
        // Si no hay match en el catálogo, el costo es desconocido — se marca para revisión manual
        costo: match ? (match.costo || 0) : null,
        sinMatch: !match
      };
    });

    const resumen = arts.map(a => `${a.nombre}${a.vnom ? ' (' + a.vnom + ')' : ''} x${a.cant}`).join(', ');
    const fecha = today();
    const fechaEntrega = calcFechaEntrega(fecha);

    // Descontar stock de cada producto/variante encontrado (igual que hace la app al cargar un pedido a mano)
    const productosAfectados = {};
    arts.forEach(a => {
      if (!a.pid || !a.vid) return;
      const p = productos.find(x => x.id === a.pid);
      if (!p || !p.variantes) return;
      const v = p.variantes.find(vv => vv.id === a.vid);
      if (!v) return;
      v.stock = (v.stock || 0) - a.cant;
      productosAfectados[p.id] = p;
    });
    for (const pid in productosAfectados) {
      await putJSON(`${FIREBASE_DB}/productos/${pid}.json`, productosAfectados[pid]);
    }

    // Número de pedido: contador atómico (evita choques con pedidos cargados a mano al mismo tiempo).
    // Resguardo extra: si por algún motivo el contador todavía no está al día con el máximo
    // ya existente (ej. primera vez que se activa esto), nos aseguramos de no repetir ningún número.
    const pedidosRaw = await fetchJSON(`${FIREBASE_DB}/pedidos.json`);
    const pedidos = pedidosRaw ? Object.values(pedidosRaw) : [];
    const maxLocal = pedidos.reduce((m, p) => Math.max(m, p.numero || 0), 999);
    let numero = await siguienteNumeroAtomico();
    if (numero === null || numero <= maxLocal) {
      numero = maxLocal + 1;
      // Ponemos el contador al día para que las próximas veces ya arranquen bien desde acá.
      await putJSON(`${FIREBASE_DB}/contadores/pedidoNumero.json`, numero);
    }

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
