// netlify/functions/meta-purchase.js
// Recibe un pedido confirmado desde la app y lo manda a Meta como evento Purchase (server-side).
const crypto = require('crypto');

function normalizarTelefonoPY(telefono) {
  let n = String(telefono || '').replace(/\D/g, ''); // deja solo dígitos
  if (!n) return '';
  if (n.startsWith('595')) {
    // ya viene con código de país
  } else if (n.startsWith('0')) {
    n = '595' + n.slice(1); // saca el 0 inicial y le pone 595
  } else {
    n = '595' + n; // asume que faltaba el código de país
  }
  return n;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: 'Method not allowed' };
  }

  try {
    // fbc y fbp son opcionales por ahora: se agregan cuando el webhook de Shopify
    // empiece a guardarlos en el pedido. Si no vienen, el evento igual se manda
    // (con menor calidad de match) en vez de fallar.
    const { telefono, monto, numero, fbc, fbp, clientIp, userAgent } = JSON.parse(event.body || '{}');

    const PIXEL_ID = process.env.META_PIXEL_ID || '937405848561054';
    const TOKEN = process.env.META_CAPI_TOKEN || process.env.META_TOKEN;

    if (!PIXEL_ID || !TOKEN) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Falta configurar META_PIXEL_ID o META_CAPI_TOKEN en Netlify' }) };
    }

    const telefonoNormalizado = normalizarTelefonoPY(telefono);
    const userData = {};
    if (telefonoNormalizado) {
      userData.ph = [crypto.createHash('sha256').update(telefonoNormalizado).digest('hex')];
    }
    if (fbc) userData.fbc = fbc;
    if (fbp) userData.fbp = fbp;
    if (clientIp) userData.client_ip_address = clientIp;
    if (userAgent) userData.client_user_agent = userAgent;

    const payload = {
      data: [
        {
          event_name: 'Purchase',
          event_time: Math.floor(Date.now() / 1000),
          // 'other' en vez de 'system_generated': esto es una compra confirmada
          // manualmente sin sesión de navegador activa en este momento, no un
          // evento automático del sistema. Cuando fbc/fbp estén disponibles,
          // idealmente pasar a 'website'.
          event_id: 'confirmado-' + String(numero || ''),
          // Con navegador conocido (user agent del pedido) Meta lo atribuye como venta web.
          action_source: userAgent ? 'website' : 'other',
          ...(userAgent ? { event_source_url: 'https://www.tiendatotal.com.py/' } : {}),
          user_data: userData,
          custom_data: {
            currency: 'PYG',
            value: Number(monto) || 0,
            order_id: String(numero || '')
          }
        }
      ]
    };

    const resp = await fetch(
      `https://graph.facebook.com/v19.0/${PIXEL_ID}/events?access_token=${TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );
    const data = await resp.json();
    console.log('Respuesta de Meta:', resp.status, JSON.stringify(data));

    return {
      statusCode: resp.ok ? 200 : 500,
      headers: CORS,
      body: JSON.stringify(data)
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
