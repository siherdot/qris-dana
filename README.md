# dana-qris

Layanan kecil untuk membuat **QRIS dinamis** (nominal otomatis) lewat API DANA,
menampilkan QR-nya, dan menerima status pembayaran dari webhook DANA.

Berdiri sendiri: tidak menempel pada aplikasi lain, cukup satu container + satu
volume SQLite.

## Isi

| Berkas | Kegunaan |
|---|---|
| `server.js` | HTTP server + routing + halaman |
| `lib/tanda.js` | Tanda tangan RSA-SHA256 (token & transaksi) |
| `lib/klien.js` | Klien DANA SNAP: token, generate QRIS, cek status |
| `lib/qris.js` | Parser/penyusun TLV EMVCo + CRC16 |
| `lib/notify.js` | Verifikasi webhook DANA |
| `lib/db.js` | SQLite (`node:sqlite`), tabel `pembayaran` |
| `lib/konfig.js` | Konfigurasi dari environment |
| `public/` | Halaman: form nominal, QR, status, riwayat |
| `test/uji.mjs` | Uji ujung-ke-ujung dengan server DANA tiruan |

## Menjalankan lokal

```bash
npm install
cp .env.example .env      # isi kredensial DANA
npm start                 # http://localhost:3000
```

Tanpa kredensial pun server tetap hidup: halaman tampil, `POST /api/qris`
menjawab `503` dengan pesan yang jelas.

Uji tanpa kredensial (membuat keypair sendiri + server DANA tiruan):

```bash
npm test
```

## Environment

| Variabel | Wajib | Keterangan |
|---|---|---|
| `DANA_ENV` | – | `sandbox` (default) atau `production` |
| `DANA_CLIENT_ID` | ya | = `X-PARTNER-ID` |
| `DANA_MERCHANT_ID` | ya | dari onboarding QRIS |
| `DANA_STORE_ID` | ya | dari onboarding QRIS |
| `DANA_PRIVATE_KEY` | ya | private key merchant (PKCS#8), boleh `\n` |
| `DANA_PUBLIC_KEY` | ya untuk webhook | public key DANA |
| `DANA_ORIGIN` | – | domain publik layanan ini |
| `DANA_CHANNEL_ID` | – | default `95221` |
| `PORT` | – | default `3000` |
| `DB_PATH` | – | default `./data/qris.db`, di container `/data/qris.db` |

## API

### `POST /api/qris`

```json
{ "nominal": 150000, "keterangan": "Pendaftaran Poli Anak" }
```

Balasan `201`:

```json
{
  "ok": true,
  "referensi": "INV261111AB12CD34EF",
  "nominal": 150000,
  "kedaluwarsa": "2026-11-11T11:00:00.000Z",
  "qrContent": "00020101021226...6304ABCD",
  "qrDataUrl": "data:image/png;base64,...",
  "lingkungan": "sandbox"
}
```

### `GET /api/qris/:referensi`

Status tagihan. Tambahkan `?cek=1` untuk menanyakan langsung ke DANA bila webhook
belum masuk.

### `POST /api/dana/notify`

Webhook DANA (`/v1.0/debit/notify`). Wajib diverifikasi dengan `DANA_PUBLIC_KEY`;
nominal harus sama dengan tagihan, dan pembaruan bersifat idempoten.

### `GET /api/health`

```json
{ "ok": true, "dana": true, "versi": "1.0.0" }
```

### `GET /api/pembayaran?batas=10`

Riwayat tagihan terakhir.

## Alur

```
POST /api/qris
  -> simpan PENDING
  -> ambil access token DANA
  -> generate QRIS (nominal ikut)
  -> simpan qrContent
  -> halaman menampilkan QR + memantau status

DANA -> POST /api/dana/notify (status "00")
  -> verifikasi tanda tangan
  -> cocokkan merchantId + nominal
  -> tandai PAID (sekali saja)
```

## Deploy di Coolify

1. Buat project baru, tambahkan resource **Application** dari repo ini dengan
   build pack **Dockerfile**.
2. Port container `3000`; domain mis. `qris.contoh.id` (Traefik + Cloudflare
   Tunnel yang sudah ada).
3. Tambahkan **Persistent Storage** volume ke `/data` (SQLite).
4. Isi environment dari `.env.example`, lalu deploy.
5. Daftarkan `https://<domain>/v1.0/debit/notify` sebagai webhook di portal DANA.
6. Healthcheck memakai `/api/health`; bila `dana: false`, env belum lengkap.

## Catatan

- Nominal disimpan sebagai integer rupiah; tidak ada pembulatan floating point.
- `partnerReferenceNo` dipotong 25 karakter (batas QRIS).
- QR dinamis sekali pakai; jangan dipakai ulang untuk tagihan lain.
- Konversi QRIS statis (`qrisDinamis`) hanya untuk QR milik sendiri dan tidak
  memberi status pembayaran otomatis.
