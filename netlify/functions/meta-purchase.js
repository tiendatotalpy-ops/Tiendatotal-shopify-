// netlify/functions/meta-purchase.js
// Recibe un pedido confirmado desde la app y lo manda a Meta como evento Purchase (server-side).
const crypto = require('crypto');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { telefono, monto, numero } = JSON.parse(event.body || '{}');

    const PIXEL_ID = process.env.META_PIXEL_ID;
    const TOKEN = process.env.META_CAPI_TOKEN;

    if (!PIXEL_ID || !TOKEN) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Falta configurar META_PIXEL_ID o META_CAPI_TOKEN en Netlify' }) };
    }

    // Meta pide el teléfono en formato E.164 (solo dígitos, con código de país) y hasheado en SHA-256.
    const telefonoLimpio = String(telefono || '').replace(/\D/g, '');
    const userData = {};
    if (telefonoLimpio) {
      userData.ph = [crypto.createHash('sha256').update(telefonoLimpio).digest('hex')];
    }

    const payload = {
      data: [
        {
          event_name: 'Purchase',
          event_time: Math.floor(Date.now() / 1000),
          action_source: 'system_generated',
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

    return {
      statusCode: resp.ok ? 200 : 500,
      body: JSON.stringify(data)
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
