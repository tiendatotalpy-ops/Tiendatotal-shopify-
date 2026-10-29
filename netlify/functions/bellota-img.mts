const DB = "https://bellota-3f304-default-rtdb.firebaseio.com";

export default async (req: Request, context: any) => {
  const { id, i } = context.params;
  const idx = Number(String(i).replace(/\.jpg$/, "")) || 0;
  let r = await fetch(`${DB}/stock/${encodeURIComponent(id)}/fotos/${idx}.json`);
  let data = r.ok ? await r.json() : null;
  if (!data && idx === 0) {
    r = await fetch(`${DB}/stock/${encodeURIComponent(id)}/foto.json`);
    data = r.ok ? await r.json() : null;
  }
  if (typeof data !== "string") return new Response("No encontrada", { status: 404 });
  if (/^https?:\/\//.test(data)) return Response.redirect(data, 302);
  const m = data.match(/^data:([^;]+);base64,(.*)$/s);
  if (!m) return new Response("Formato inválido", { status: 404 });
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    headers: { "content-type": m[1], "cache-control": "public, max-age=86400" },
  });
};

export const config = { path: "/bellota/img/:id/:i" };
