const DB = "https://bellota-3f304-default-rtdb.firebaseio.com";
const WEB = "https://bellotastore.netlify.app";

const clean = (s: unknown) =>
  String(s ?? "").replace(/[*_#`]/g, "").replace(/\s+/g, " ").trim();
const csv = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

export default async (req: Request) => {
  const base = new URL(req.url).origin;
  const r = await fetch(`${DB}/stock.json`);
  if (!r.ok) return new Response("Error leyendo productos", { status: 502 });
  const stock = (await r.json()) || {};

  const head = ["id","title","description","availability","condition","price","link","image_link","additional_image_link","brand","inventory","product_type","retailer_id"];
  const rows: string[] = [head.join(",")];

  for (const [id, p] of Object.entries<any>(stock)) {
    if (!p || p.activo === false || p.ocultoWeb) continue;
    if (!p.nombre || !p.precio) continue;
    const fotos: string[] = Array.isArray(p.fotos) && p.fotos.length ? p.fotos : p.foto ? [p.foto] : [];
    if (!fotos.length) continue;
    let qty = Number(p.stock) || 0;
    if (p.tieneVariantes && p.variantes) {
      qty = Object.values<any>(p.variantes).reduce((a, v) => a + (Number(v?.stock) || 0), 0);
    }
    const imgs = fotos.map((_, i) => `${base}/bellota/img/${id}/${i}.jpg`);
    const desc = clean(p.descripcion) || clean(p.nombre);
    rows.push([
      id,
      clean(p.nombre).slice(0, 150),
      desc.slice(0, 5000),
      qty > 0 ? "in stock" : "out of stock",
      "new",
      `${Math.round(Number(p.precio))} PYG`,
      `${WEB}/?p=${encodeURIComponent(id)}`,
      imgs[0],
      imgs.slice(1, 10).join(","),
      "Bellota",
      qty,
      clean(p.categoria),
      id,
    ].map(csv).join(","));
  }

  return new Response(rows.join("\n"), {
    headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "public, max-age=900" },
  });
};

export const config = { path: "/bellota/feed.csv" };
