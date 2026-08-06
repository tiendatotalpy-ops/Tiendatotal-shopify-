// netlify/functions/shopify-product-update-webhook.js
// Recibe el aviso de Shopify cuando se ACTUALIZA un producto ya existente
// (cambia SKU, precio, foto, etc.) y actualiza esos datos en la app (Firebase).
// A diferencia del sync app->Shopify, esto NO necesita permisos especiales,
// porque es Shopify quien manda los datos, no la app pidiéndolos.

const crypto = require('crypto');
const https = require('https');

const FIREBASE_DB = 'https://tienda-total-py-default-rtdb.firebaseio.com';
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

function verificarFirma(rawBody, hmacHeader) {
  if (!SHOPIFY_WEBHOOK_SECRET || !hmacHeader) return false;
  const hash = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET).update(rawBody, 'utf8').digest('base64');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmacHeader));
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let resp = '';
      res.on('data', c => resp += c);
      res.on('end', () => {
        try { resolve(JSON.parse(resp || 'null')); }
        catch (e) { resolve(null); }
      });
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


// Guarda el diagnóstico de cada ejecución en Firebase para poder revisarlo fácil
function guardarDiag(diag) {
  diag.hora = new Date().toISOString();
  return putJSON(`${FIREBASE_DB}/debugWebhook.json`, diag).catch(() => {});
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

exports.handler = async (event) => {
  try {
    const hmac = event.headers['x-shopify-hmac-sha256'] || event.headers['X-Shopify-Hmac-Sha256'];
    if (!verificarFirma(event.body, hmac)) {
      console.log('RESULTADO: FIRMA INVALIDA — el secreto de Netlify no coincide');
      await guardarDiag({ resultado: 'FIRMA INVALIDA — el secreto en Netlify no coincide con el de Shopify' });
      return { statusCode: 401, body: 'Firma inválida' };
    }
    const prod = JSON.parse(event.body);
    console.log('WEBHOOK UPDATE recibido:', prod.id, '|', prod.title, '| SKUs:', (prod.variants||[]).map(v=>v.sku).join(','));

    // Buscar en Firebase el producto que tenga este shopifyProductId
    const todos = await getJSON(`${FIREBASE_DB}/productos.json`);
    if (!todos) { console.log('RESULTADO: Firebase sin productos'); return { statusCode: 200, body: 'Sin productos en la app todavía' }; }

    let idFirebase = null;
    for (const [key, val] of Object.entries(todos)) {
      if (val && String(val.shopifyProductId) === String(prod.id)) { idFirebase = key; break; }
    }
    // Si no hay vínculo todavía, intentar emparejar por SKU (para productos viejos
    // que ya existían en la app y en Shopify antes de esta sincronización).
    let esVinculoNuevo = false;
    if (!idFirebase) {
      const skusShopify = (prod.variants || []).map(v => (v.sku || '').trim()).filter(Boolean);
      if (skusShopify.length) {
        for (const [key, val] of Object.entries(todos)) {
          if (!val || val.shopifyProductId) continue; // ya vinculado a otro, no tocar
          const skusApp = [val.codigo, ...((val.variantes || []).map(v => v.codigo))].map(s => (s || '').trim()).filter(Boolean);
          if (skusApp.some(s => skusShopify.includes(s))) { idFirebase = key; esVinculoNuevo = true; break; }
        }
      }
    }
    // Respaldo: emparejar por NOMBRE exacto (ignorando mayúsculas y espacios extra),
    // para cuando los SKU ya no coinciden porque se cambiaron primero en Shopify.
    if (!idFirebase) {
      const norm = s => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const nombreShopify = norm(prod.title);
      if (nombreShopify) {
        for (const [key, val] of Object.entries(todos)) {
          if (!val || val.shopifyProductId) continue;
          if (norm(val.nombre) === nombreShopify) { idFirebase = key; esVinculoNuevo = true; break; }
        }
      }
    }
    console.log('RESULTADO MATCH:', idFirebase ? ('encontrado id='+idFirebase+(esVinculoNuevo?' (vinculo NUEVO)':' (ya vinculado)')) : 'NO ENCONTRADO — se ignora');
    await guardarDiag({
      resultado: idFirebase ? ('EMPAREJADO con id '+idFirebase+(esVinculoNuevo?' (vínculo nuevo)':' (ya estaba vinculado)')) : 'NO EMPAREJADO — ningún producto de la app coincide ni por ID, ni por SKU, ni por nombre',
      producto_shopify: prod.title,
      skus_shopify: (prod.variants||[]).map(v=>v.sku),
      nombres_en_app: Object.values(todos).filter(Boolean).map(p=>p.nombre)
    });
    // Si no se encontró en la app, se CREA directamente (copia fiel de Shopify)
    if (!idFirebase) {
      const imgN = (prod.image && prod.image.src) || (prod.images && prod.images[0] && prod.images[0].src) || '';
      const vShop = prod.variants || [];
      const tieneVars = vShop.length > 1 || (vShop.length === 1 && vShop[0].title && vShop[0].title !== 'Default Title');
      const nuevoProd = {
        nombre: prod.title || 'Producto sin nombre',
        codigo: (!tieneVars && vShop[0]) ? (vShop[0].sku || '') : '',
        proveedor: '',
        precio: parseFloat((vShop[0] && vShop[0].price) || 0),
        costo: 0, margen: 0, img: imgN,
        variantes: tieneVars ? vShop.map(v => ({ id: uid(), color: v.title || '', hex: '#7ed957', stock: v.inventory_quantity || 0, codigo: v.sku || '' })) : [],
        stock: tieneVars ? 0 : (vShop[0] ? (vShop[0].inventory_quantity || 0) : 0),
        origen: 'shopify',
        shopifyProductId: prod.id
      };
      const nid = uid();
      nuevoProd.id = nid;
      await putJSON(`${FIREBASE_DB}/productos/${nid}.json`, nuevoProd);
      await guardarDiag({ resultado: 'CREADO NUEVO en la app (no existía)', producto: prod.title, codigo: nuevoProd.codigo || 'variantes' });
      return { statusCode: 200, body: 'Creado' };
    }

    const actual = todos[idFirebase];
    const variantsShopify = prod.variants || [];
    const img = (prod.image && prod.image.src) || (prod.images && prod.images[0] && prod.images[0].src) || actual.img || '';
    const tieneVariantesReales = variantsShopify.length > 1 ||
      (variantsShopify.length === 1 && variantsShopify[0].title && variantsShopify[0].title !== 'Default Title');

    const cambios = {
      nombre: prod.title || actual.nombre,
      img,
      precio: parseFloat((variantsShopify[0] && variantsShopify[0].price) || actual.precio || 0)
    };

    if (tieneVariantesReales) {
      // Actualiza el SKU/color de cada variante que ya existía (por posición), agrega las nuevas
      const variantesActuales = actual.variantes || [];
      cambios.variantes = variantsShopify.map((v, i) => {
        const existente = variantesActuales[i];
        return {
          id: existente ? existente.id : (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
          color: v.title || (existente ? existente.color : ''),
          hex: existente ? existente.hex : '#7ed957',
          stock: existente ? existente.stock : (v.inventory_quantity || 0),
          codigo: v.sku || ''
        };
      });
    } else {
      cambios.codigo = (variantsShopify[0] && variantsShopify[0].sku) || actual.codigo || '';
    }

    cambios.margen = cambios.precio > 0 ? Math.round((cambios.precio - (actual.costo || 0)) / cambios.precio * 100) : 0;
    if (esVinculoNuevo) cambios.shopifyProductId = prod.id; // guardar el vínculo para la próxima vez

    await putJSON(`${FIREBASE_DB}/productos/${idFirebase}.json`, { ...actual, ...cambios });
    console.log('GUARDADO OK en Firebase:', idFirebase, '| codigo nuevo:', cambios.codigo || '(variantes)');
    await guardarDiag({ resultado: 'GUARDADO OK', producto: prod.title, codigo_nuevo: cambios.codigo || 'variantes actualizadas' });

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: 'Error: ' + err.message };
  }
};
