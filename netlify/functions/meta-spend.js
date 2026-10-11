// netlify/functions/meta-spend.js
// Función programada (cada 30 min, ver netlify.toml): trae de Meta el gasto publicitario
// de cada día del mes actual de la cuenta de Tienda Total y lo guarda en Firebase
// en gastoAds/AAAA-MM-DD = { spend, actualizado }. La app lo usa para la ganancia neta real.
//
// Requiere la variable de entorno META_TOKEN en Netlify (token de usuario del sistema con ads_read).

const FIREBASE_DB = 'https://tienda-total-py-default-rtdb.firebaseio.com';
const AD_ACCOUNT = process.env.META_AD_ACCOUNT || 'act_501646525798527';
const META_TOKEN = process.env.META_TOKEN;

function hoyPY() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Asuncion' }); }

async function guardarEstado(obj) {
  try {
    await fetch(`${FIREBASE_DB}/gastoAdsEstado.json`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...obj, hora: new Date().toISOString() })
    });
  } catch (e) { /* sin estado */ }
}

exports.handler = async () => {
  if (!META_TOKEN) {
    await guardarEstado({ ok: false, error: 'Falta la variable META_TOKEN en Netlify' });
    return { statusCode: 500, body: 'Falta META_TOKEN' };
  }
  try {
    const hoy = hoyPY();
    const desde = hoy.slice(0, 8) + '01';
    const params = new URLSearchParams({
      fields: 'spend',
      level: 'account',
      time_increment: '1',
      time_range: JSON.stringify({ since: desde, until: hoy }),
      limit: '40',
      access_token: META_TOKEN
    });
    const r = await fetch(`https://graph.facebook.com/v21.0/${AD_ACCOUNT}/insights?${params}`);
    const data = await r.json();
    if (data.error) {
      await guardarEstado({ ok: false, error: data.error.message });
      return { statusCode: 502, body: 'Meta: ' + data.error.message };
    }
    const actualizado = new Date().toISOString();
    const updates = {};
    for (const fila of (data.data || [])) {
      updates[fila.date_start] = { spend: Math.round(parseFloat(fila.spend || 0)), actualizado };
    }
    // Si hoy todavía no gastó nada, Meta no devuelve la fila: dejamos hoy en 0 igual
    if (!updates[hoy]) updates[hoy] = { spend: 0, actualizado };
    await fetch(`${FIREBASE_DB}/gastoAds.json`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    await guardarEstado({ ok: true, dias: Object.keys(updates).length, hoy: updates[hoy].spend });
    return { statusCode: 200, body: JSON.stringify(updates) };
  } catch (err) {
    await guardarEstado({ ok: false, error: err.message });
    return { statusCode: 500, body: 'Error: ' + err.message };
  }
};
