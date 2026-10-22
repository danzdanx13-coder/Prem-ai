// Kirim pesan ke Claude. Riwayat disimpan di server, paket dan kuota dicek di server.
const crypto = require("crypto");
const { PLANS, json, user, db, currentPlan, useQuota, updateIndex } = require("../lib/common");

const MODEL = { cepat: "claude-haiku-5-5", belajar: "claude-sonnet-5-5", cerdas: "claude-opus-5-5" };
const SYSTEM = "Kamu adalah damz ai, asisten AI yang ramah dan jelas. Jawab dalam bahasa Indonesia kecuali pengguna memakai bahasa lain. Untuk mode belajar, jelaskan langkah demi langkah dengan contoh. Jika ada foto, deskripsikan dan jawab berdasarkan isinya.";

exports.handler = async (event, context) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Metode tidak diizinkan." });
  const u = user(context);
  if (!u) return json(401, { error: "Silakan masuk terlebih dahulu.", code: "AUTH" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Permintaan tidak valid." }); }
  const { mode, conversationId } = body;
  const text = String(body.text || "").trim().slice(0, 8000);
  if (!MODEL[mode]) return json(400, { error: "Mode tidak dikenal." });
  if (!text && !body.image) return json(400, { error: "Pesan kosong." });

  let image = null;
  if (body.image) {
    const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(body.image);
    if (!m) return json(400, { error: "Format foto tidak didukung." });
    if (m[2].length > 7_000_000) return json(400, { error: "Foto terlalu besar." });
    image = { media_type: m[1], data: m[2] };
  }

  const plan = await currentPlan(u.id);
  if (!PLANS[plan].modes.includes(mode)) {
    return json(403, { error: "Mode ini hanya untuk paket Premium atau Max.", code: "PLAN" });
  }
  const quota = await useQuota(u.id, plan);
  if (!quota.ok) {
    return json(429, { error: "Batas pemakaian hari ini sudah habis. Coba lagi besok atau upgrade paket.", code: "QUOTA" });
  }

  const cid = conversationId || crypto.randomUUID();
  const key = `conv:${u.id}:${cid}`;
  const conv = (await db().get(key, { type: "json" })) || { id: cid, title: "", messages: [] };

  // Riwayat untuk Claude: teks saja, dimulai dari pesan pengguna
  let past = conv.messages.slice(-18).map((m) => ({ role: m.role, content: m.text }));
  while (past.length && past[0].role !== "user") past.shift();

  const current = [];
  if (image) current.push({ type: "image", source: { type: "base64", ...image } });
  current.push({ type: "text", text: text || "Tolong jelaskan foto ini." });

  let reply;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL[mode],
        max_tokens: 1024,
        system: SYSTEM,
        messages: [...past, { role: "user", content: current }],
      }),
    });
    const out = await res.json();
    if (!res.ok) return json(502, { error: "Layanan AI sedang bermasalah. Coba lagi." });
    reply = (out.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  } catch {
    return json(502, { error: "Tidak bisa terhubung ke layanan AI." });
  }

  conv.messages.push(
    { role: "user", text: text || "Tolong jelaskan foto ini.", hasImage: !!image },
    { role: "assistant", text: reply }
  );
  if (!conv.title) conv.title = (text || "Foto").slice(0, 40);
  conv.updated = Date.now();
  await db().setJSON(key, conv);
  await updateIndex(u.id, { id: cid, title: conv.title, updated: conv.updated });

  return json(200, {
    conversationId: cid,
    text: reply,
    quota: { used: quota.used, limit: PLANS[plan].daily },
  });
};
