/**
 * Uji ujung-ke-ujung tanpa kredensial DANA asli.
 *
 *   npm test
 *
 * Yang diuji: tanda tangan (persis cara DANA memverifikasi), pembuatan QRIS
 * lewat server tiruan, penyimpanan, webhook sah/palsu, dan idempotensi.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bacaNominal,
  crcValid,
  denganCrc,
  parseTlv,
  qrisDinamis,
  rakitTlv,
} from "../lib/qris.js";
import { hashBody, stringToSignToken, stringToSignTransaksi, tanda, verifikasi } from "../lib/tanda.js";

const AKAR = fileURLToPath(new URL("..", import.meta.url));
let gagal = 0;

function cek(nama, syarat, info) {
  if (syarat) {
    console.log(`  ok    ${nama}`);
  } else {
    gagal++;
    console.log(`  GAGAL ${nama}`, info ?? "");
  }
}

/* ---------- kunci ---------- */
const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
const merchantPriv = merchant.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const merchantPub = merchant.publicKey.export({ type: "spki", format: "pem" }).toString();

const dana = generateKeyPairSync("rsa", { modulusLength: 2048 });
const danaPriv = dana.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const danaPub = dana.publicKey.export({ type: "spki", format: "pem" }).toString();

/* ---------- QRIS contoh (milik sendiri) ---------- */
const akun = rakitTlv([
  { id: "00", value: "ID.CO.QRIS.WWW" },
  { id: "01", value: "936009140000000000" },
  { id: "02", value: "15" },
  { id: "03", value: "UMI" },
]);
const nmid = rakitTlv([
  { id: "00", value: "ID.CO.QRIS.WWW" },
  { id: "02", value: "ID0000000000000" },
  { id: "03", value: "UMI" },
]);
const statis = denganCrc(
  rakitTlv([
    { id: "00", value: "01" },
    { id: "01", value: "11" },
    { id: "26", value: akun },
    { id: "51", value: nmid },
    { id: "52", value: "5812" },
    { id: "53", value: "360" },
    { id: "58", value: "ID" },
    { id: "59", value: "TOKO CONTOH" },
    { id: "60", value: "JAKARTA" },
    { id: "61", value: "20112" },
  ])
);

/* ---------- 1. tanda tangan ---------- */
const ts = "2026-11-11T10:00:00+07:00";
const sToken = stringToSignToken("CLIENT123", ts);
cek("format string token", sToken === "CLIENT123|2026-11-11T10:00:00+07:00", sToken);
cek("tanda token sah", verifikasi(sToken, tanda(sToken, merchantPriv), merchantPub));

const bodyContoh = JSON.stringify({ a: 1 });
const sTrx = stringToSignTransaksi("POST", "/v1.0/qr/qr-mpm-generate.htm", bodyContoh, ts);
cek(
  "format string transaksi",
  sTrx === `POST:/v1.0/qr/qr-mpm-generate.htm:${hashBody(bodyContoh)}:${ts}`,
  sTrx
);
cek("tanda transaksi sah", verifikasi(sTrx, tanda(sTrx, merchantPriv), merchantPub));
cek("tanda transaksi salah kunci ditolak", !verifikasi(sTrx, tanda(sTrx, danaPriv), merchantPub));

/* ---------- 2. QRIS dinamis ---------- */
const dinamis = qrisDinamis(statis, 150000);
const ids = parseTlv(dinamis).map((t) => t.id);
cek("CRC QRIS contoh valid", crcValid(statis));
cek("tag 54 terisi", bacaNominal(dinamis) === 150000, bacaNominal(dinamis));
cek("CRC hasil konversi valid", crcValid(dinamis), dinamis);
cek("urutan tag 54 benar", ids.indexOf("54") === ids.indexOf("53") + 1 && ids.indexOf("58") > ids.indexOf("54"), ids);
cek("tag 63 tetap terakhir", ids.at(-1) === "63");

/* ---------- 3. server tiruan DANA ---------- */
const diterima = [];
const mock = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const jalur = String(req.url);
    const waktu = String(req.headers["x-timestamp"]);
    const sig = String(req.headers["x-signature"]);
    const kirim = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };

    if (jalur === "/v1.0/access-token/b2b.htm") {
      const sah = verifikasi(stringToSignToken(String(req.headers["x-client-key"]), waktu), sig, merchantPub);
      return kirim(
        sah ? 200 : 401,
        sah
          ? { responseCode: "2007300", responseMessage: "Successful", accessToken: "token-uji", expiresIn: "900" }
          : { responseCode: "4017300", responseMessage: "Unauthorized" }
      );
    }

    if (jalur === "/v1.0/qr/qr-mpm-generate.htm") {
      const sah =
        req.headers.authorization === "Bearer token-uji" &&
        verifikasi(stringToSignTransaksi("POST", jalur, raw, waktu), sig, merchantPub);
      const isi = JSON.parse(raw);
      diterima.push(isi);
      return kirim(
        sah ? 200 : 401,
        sah
          ? {
              responseCode: "2004700",
              responseMessage: "Successful",
              referenceNo: `DANA-${randomUUID().slice(0, 8)}`,
              partnerReferenceNo: isi.partnerReferenceNo,
              qrContent: qrisDinamis(statis, Number(isi.amount.value)),
              qrUrl: "https://example.test/qr.png",
            }
          : { responseCode: "4014700", responseMessage: "Unauthorized" }
      );
    }

    if (jalur === "/rest/v1.1/debit/status") {
      const isi = JSON.parse(raw);
      return kirim(200, {
        responseCode: "2005500",
        responseMessage: "Successful",
        originalPartnerReferenceNo: isi.originalPartnerReferenceNo,
        latestTransactionStatus: "00",
        amount: { value: "150000.00", currency: "IDR" },
      });
    }

    kirim(404, {});
  });
});

await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const portMock = mock.address().port;

/* ---------- 4. jalankan aplikasi ---------- */
const direktoriDb = mkdtempSync(join(tmpdir(), "dana-qris-"));
const portApp = 40000 + Math.floor(Math.random() * 10000);
const anak = spawn(process.execPath, ["server.js"], {
  cwd: AKAR,
  env: {
    ...process.env,
    PORT: String(portApp),
    DB_PATH: join(direktoriDb, "uji.db"),
    DANA_ENV: "sandbox",
    DANA_BASE_URL: `http://127.0.0.1:${portMock}`,
    DANA_CLIENT_ID: "CLIENT123",
    DANA_MERCHANT_ID: "M1",
    DANA_STORE_ID: "S1",
    DANA_PRIVATE_KEY: merchantPriv,
    DANA_PUBLIC_KEY: danaPub,
    DANA_ORIGIN: "http://localhost",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let logServer = "";
anak.stdout.on("data", (c) => (logServer += c.toString()));
anak.stderr.on("data", (c) => (logServer += c.toString()));

await new Promise((selesai, gagalJalan) => {
  const batas = setTimeout(() => gagalJalan(new Error(`server tidak siap:\n${logServer}`)), 15_000);
  const cekSiap = setInterval(() => {
    if (logServer.includes("mendengarkan")) {
      clearInterval(cekSiap);
      clearTimeout(batas);
      selesai();
    }
  }, 100);
});

const dasar = `http://127.0.0.1:${portApp}`;
const ambil = async (jalur, opsi) => {
  const res = await fetch(dasar + jalur, opsi);
  return { status: res.status, data: await res.json().catch(() => null) };
};

try {
  const sehat = await ambil("/api/health");
  cek("health melaporkan DANA aktif", sehat.status === 200 && sehat.data.dana === true, sehat.data);

  const halaman = await fetch(dasar + "/");
  cek("halaman utama tersaji", halaman.status === 200 && (await halaman.text()).includes("QRIS Dinamis"));

  const buat = await ambil("/api/qris", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nominal: 150000, keterangan: "Pendaftaran Poli Anak" }),
  });
  const referensi = buat.data?.referensi;
  cek("POST /api/qris -> 201", buat.status === 201, buat.data);
  cek("nominal masuk ke QR", bacaNominal(buat.data.qrContent) === 150000, bacaNominal(buat.data.qrContent));
  cek("QR dirender sebagai PNG", String(buat.data.qrDataUrl).startsWith("data:image/png;base64,"));
  cek("referensi <= 25 karakter", referensi.length <= 25, referensi);
  cek("DANA menerima 2 desimal", diterima.at(-1)?.amount?.value === "150000.00", diterima.at(-1)?.amount);

  const awal = await ambil(`/api/qris/${referensi}`);
  cek("status awal PENDING", awal.data.status === "PENDING", awal.data);

  const notif = JSON.stringify({
    originalPartnerReferenceNo: referensi,
    originalReferenceNo: buat.data.referensi_dana ?? "DANA-REF",
    merchantId: "M1",
    amount: { value: "150000.00", currency: "IDR" },
    latestTransactionStatus: "00",
    paidTime: new Date().toISOString(),
  });
  const tsHook = new Date(Date.now() + 7 * 3600_000).toISOString().replace("Z", "+07:00");
  const tandaHook = (isi) =>
    tanda(stringToSignTransaksi("POST", "/v1.0/debit/notify", isi, tsHook), danaPriv);

  const palsu = await ambil("/v1.0/debit/notify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-TIMESTAMP": tsHook,
      "X-SIGNATURE": tandaHook(notif.replace("150000.00", "1000.00")),
    },
    body: notif,
  });
  cek("webhook dengan body diubah ditolak", palsu.status === 401, palsu.data);

  const tanpaTanda = await ambil("/v1.0/debit/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: notif,
  });
  cek("webhook tanpa tanda tangan ditolak", tanpaTanda.status === 401);

  const sah = await ambil("/v1.0/debit/notify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-TIMESTAMP": tsHook,
      "X-SIGNATURE": tandaHook(notif),
    },
    body: notif,
  });
  cek("webhook sah diterima", sah.status === 200 && sah.data.responseCode === "2005600", sah.data);

  const setelah = await ambil(`/api/qris/${referensi}`);
  cek("status jadi PAID", setelah.data.status === "PAID", setelah.data);

  const dibayarPada = setelah.data.dibayar_pada;
  await ambil("/v1.0/debit/notify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-TIMESTAMP": tsHook,
      "X-SIGNATURE": tandaHook(notif),
    },
    body: notif,
  });
  const ulang = await ambil(`/api/qris/${referensi}`);
  cek("webhook ganda tidak mengubah data", ulang.data.status === "PAID" && ulang.data.dibayar_pada === dibayarPada);

  const nominalSalah = await ambil("/api/qris", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nominal: 50000 }),
  });
  const notifSalah = JSON.stringify({
    originalPartnerReferenceNo: nominalSalah.data.referensi,
    merchantId: "M1",
    amount: { value: "1000.00", currency: "IDR" },
    latestTransactionStatus: "00",
  });
  await ambil("/v1.0/debit/notify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-TIMESTAMP": tsHook,
      "X-SIGNATURE": tanda(stringToSignTransaksi("POST", "/v1.0/debit/notify", notifSalah, tsHook), danaPriv),
    },
    body: notifSalah,
  });
  const cekNominal = await ambil(`/api/qris/${nominalSalah.data.referensi}`);
  cek("nominal tidak cocok tidak menandai lunas", cekNominal.data.status === "PENDING", cekNominal.data);

  const invalid = await ambil("/api/qris", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nominal: -5 }),
  });
  cek("nominal negatif ditolak 422", invalid.status === 422);

  const riwayat = await ambil("/api/pembayaran?batas=5");
  cek("riwayat berisi 2 tagihan", riwayat.data.data.length === 2, riwayat.data.data?.length);
} finally {
  anak.kill("SIGTERM");
  mock.close();
}

console.log(gagal === 0 ? "\nSEMUA UJI LULUS" : `\n${gagal} UJI GAGAL`);
process.exit(gagal === 0 ? 0 : 1);
