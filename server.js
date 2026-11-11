import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { konfigurasiDariEnv, sudahDikonfigurasi } from "./lib/konfig.js";
import { buatQris, cekStatus, DanaError, nomorReferensi } from "./lib/klien.js";
import { sudahDibayar, PATH_NOTIFY, verifikasiWebhook } from "./lib/notify.js";
import {
  ambilPembayaran,
  buatPembayaran,
  daftarTerbaru,
  simpanQr,
  tandaiKedaluwarsa,
  tandaiLunas,
} from "./lib/db.js";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIK = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const BATAS_BODY = 32 * 1024;

const TIPE = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function json(res, status, data) {
  const isi = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(isi),
  });
  res.end(isi);
}

async function bacaBody(req) {
  let total = 0;
  const potongan = [];
  for await (const c of req) {
    total += c.length;
    if (total > BATAS_BODY) throw new Error("Body terlalu besar");
    potongan.push(c);
  }
  return Buffer.concat(potongan).toString("utf8");
}

function validasiNominal(nilai) {
  const n = Number(nilai);
  if (!Number.isInteger(n) || n < 1 || n > 50_000_000) return null;
  return n;
}

async function layaniStatis(res, jalur) {
  const aman = normalize(jalur).replace(/^(\.\.[/\\])+/, "");
  const berkas = join(PUBLIK, aman === "/" ? "index.html" : aman);
  if (!berkas.startsWith(PUBLIK)) return json(res, 403, { ok: false, pesan: "Akses ditolak." });
  try {
    const isi = await readFile(berkas);
    res.writeHead(200, {
      "Content-Type": TIPE[extname(berkas)] ?? "application/octet-stream",
      "Content-Length": isi.length,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(isi);
  } catch {
    json(res, 404, { ok: false, pesan: "Tidak ditemukan." });
  }
}

async function buatTagihan(req, res) {
  const k = konfigurasiDariEnv();
  if (!k) {
    return json(res, 503, {
      ok: false,
      pesan:
        "DANA belum dikonfigurasi. Isi DANA_CLIENT_ID, DANA_MERCHANT_ID, DANA_STORE_ID, dan DANA_PRIVATE_KEY.",
    });
  }

  let isi;
  try {
    isi = JSON.parse(await bacaBody(req));
  } catch {
    return json(res, 400, { ok: false, pesan: "Format permintaan tidak valid." });
  }

  const nominal = validasiNominal(isi.nominal);
  if (!nominal) {
    return json(res, 422, { ok: false, pesan: "Nominal harus rupiah bulat antara 1 dan 50.000.000." });
  }

  const keterangan = String(isi.keterangan ?? "").trim().slice(0, 200) || "Pembayaran QRIS";
  const referensi = nomorReferensi();
  const kedaluwarsa = new Date(Date.now() + 30 * 60_000);

  try {
    // Simpan PENDING lebih dulu: webhook bisa datang sangat cepat.
    buatPembayaran({ referensi, keterangan, nominal, kedaluwarsa });

    const qr = await buatQris(k, { nominal, partnerReferenceNo: referensi, berlakuMenit: 30 });
    if (!qr.qrContent) throw new Error("DANA tidak mengembalikan qrContent");

    simpanQr(referensi, { qrContent: qr.qrContent, qrUrl: qr.qrUrl, referensiDana: qr.referenceNo });

    return json(res, 201, {
      ok: true,
      referensi,
      nominal,
      keterangan,
      kedaluwarsa: kedaluwarsa.toISOString(),
      qrContent: qr.qrContent,
      qrUrl: qr.qrUrl ?? null,
      qrDataUrl: await QRCode.toDataURL(qr.qrContent, { width: 512, margin: 1 }),
      lingkungan: k.env,
    });
  } catch (err) {
    const dana = err instanceof DanaError ? err : null;
    console.error("[qris] gagal:", dana?.responseCode ?? err.message);
    return json(res, 502, {
      ok: false,
      pesan: dana?.message ?? "Gagal membuat QRIS.",
      kode: dana?.responseCode ?? null,
    });
  }
}

async function webhook(req, res) {
  const k = konfigurasiDariEnv();
  if (!k?.publicKey) {
    console.error("[notify] DANA_PUBLIC_KEY belum diisi");
    return json(res, 503, { responseCode: "5005600", responseMessage: "Not configured" });
  }

  const body = await bacaBody(req);
  const sah = verifikasiWebhook(
    {
      signature: req.headers["x-signature"],
      timestamp: req.headers["x-timestamp"],
      body,
      path: PATH_NOTIFY,
    },
    k.publicKey
  );

  if (!sah) {
    console.warn("[notify] tanda tangan tidak valid");
    return json(res, 401, { responseCode: "4015600", responseMessage: "Unauthorized" });
  }

  let notif;
  try {
    notif = JSON.parse(body);
  } catch {
    return json(res, 400, { responseCode: "4005600", responseMessage: "Bad Request" });
  }

  // Setelah tanda tangan sah, selalu balas 200 agar DANA tidak mengulang terus.
  const balasan = { responseCode: "2005600", responseMessage: "Successful" };
  const referensi = notif.originalPartnerReferenceNo;
  const tagihan = referensi ? ambilPembayaran(referensi) : null;

  if (!tagihan) {
    console.warn("[notify] tagihan tidak dikenal:", referensi);
    return json(res, 200, balasan);
  }

  if (notif.merchantId !== k.merchantId) {
    console.warn("[notify] merchantId tidak cocok:", notif.merchantId);
    return json(res, 200, balasan);
  }

  if (!sudahDibayar(notif)) {
    tandaiKedaluwarsa(referensi);
    return json(res, 200, balasan);
  }

  const nilai = Number(notif.amount?.value);
  if (!Number.isFinite(nilai) || Math.round(nilai) !== tagihan.nominal) {
    console.error("[notify] nominal tidak cocok:", nilai, "vs", tagihan.nominal);
    return json(res, 200, balasan);
  }

  const berubah = tandaiLunas(referensi, nilai, notif.originalReferenceNo, notif.paidTime);
  console.log("[notify] lunas:", referensi, "berubah:", berubah);
  return json(res, 200, balasan);
}

async function statusTagihan(res, referensi, cekDana) {
  const data = ambilPembayaran(referensi);
  if (!data) return json(res, 404, { ok: false, pesan: "Tagihan tidak ditemukan." });

  // Bila webhook belum masuk, tanya DANA langsung (opsional, butuh kredensial).
  const k = konfigurasiDariEnv();
  if (cekDana && k && data.status === "PENDING") {
    try {
      const hasil = await cekStatus(k, {
        partnerReferenceNo: data.referensi,
        referenceNo: data.referensi_dana,
      });
      if (hasil.latestTransactionStatus === "00" && hasil.amount?.value) {
        tandaiLunas(data.referensi, Number(hasil.amount.value), data.referensi_dana, null);
      }
    } catch (err) {
      console.warn("[status] cek ke DANA gagal:", err.message);
    }
  }

  const terbaru = ambilPembayaran(referensi);
  return json(res, 200, {
    ok: true,
    referensi: terbaru.referensi,
    nominal: terbaru.nominal,
    keterangan: terbaru.keterangan,
    status: terbaru.status,
    qrDataUrl: terbaru.qr_content
      ? await QRCode.toDataURL(terbaru.qr_content, { width: 512, margin: 1 })
      : null,
    kedaluwarsa: terbaru.kedaluwarsa,
    dibayar_pada: terbaru.dibayar_pada,
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const jalur = decodeURIComponent(url.pathname);
  const mulai = Date.now();

  res.on("finish", () => {
    if (jalur.startsWith("/api/")) {
      console.log(`${req.method} ${jalur} -> ${res.statusCode} (${Date.now() - mulai}ms)`);
    }
  });

  try {
    if (req.method === "GET" && jalur === "/api/health") {
      return json(res, 200, { ok: true, dana: sudahDikonfigurasi(), versi: "1.0.0" });
    }
    if (req.method === "GET" && jalur === "/api/pembayaran") {
      return json(res, 200, {
        ok: true,
        data: daftarTerbaru(url.searchParams.get("batas")).map((b) => ({
          referensi: b.referensi,
          keterangan: b.keterangan,
          nominal: b.nominal,
          status: b.status,
          dibuat_pada: b.dibuat_pada,
          dibayar_pada: b.dibayar_pada,
        })),
      });
    }
    if (req.method === "POST" && jalur === "/api/qris") return await buatTagihan(req, res);
    if (req.method === "GET" && jalur.startsWith("/api/qris/")) {
      return await statusTagihan(res, jalur.slice("/api/qris/".length), url.searchParams.has("cek"));
    }
    if (req.method === "POST" && jalur === PATH_NOTIFY) return await webhook(req, res);
    if (req.method === "GET" || req.method === "HEAD") return await layaniStatis(res, jalur);

    return json(res, 405, { ok: false, pesan: "Metode tidak didukung." });
  } catch (err) {
    console.error("[server]", err);
    if (!res.headersSent) json(res, 500, { ok: false, pesan: "Terjadi kesalahan di server." });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`dana-qris mendengarkan di :${PORT} (DANA ${sudahDikonfigurasi() ? "aktif" : "belum dikonfigurasi"})`);
});

for (const sinyal of ["SIGTERM", "SIGINT"]) {
  process.on(sinyal, () => {
    console.log(`${sinyal} diterima, menutup server.`);
    server.close(() => process.exit(0));
  });
}
