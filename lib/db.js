import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Penyimpanan tagihan. SQLite (built-in Node) supaya layanan ini cukup satu
 * container + satu volume; tidak perlu database terpisah.
 *
 * nominal disimpan sebagai INTEGER rupiah (bukan float) agar tidak ada
 * pembulatan aneh saat dicocokkan dengan nilai dari DANA.
 */

const BERKAS = process.env.DB_PATH ?? "./data/qris.db";

let db = null;

export function bukaDb() {
  if (db) return db;
  mkdirSync(dirname(BERKAS), { recursive: true });
  db = new DatabaseSync(BERKAS);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS pembayaran (
      referensi        TEXT PRIMARY KEY,
      referensi_dana   TEXT,
      keterangan       TEXT NOT NULL DEFAULT '',
      nominal          INTEGER NOT NULL CHECK (nominal > 0),
      status           TEXT NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING', 'PAID', 'EXPIRED', 'CANCEL')),
      qr_content       TEXT,
      qr_url           TEXT,
      kedaluwarsa      TEXT,
      dibayar_pada     TEXT,
      dibuat_pada      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pembayaran_status ON pembayaran (status, dibuat_pada DESC);
  `);
  return db;
}

export function buatPembayaran({ referensi, keterangan, nominal, kedaluwarsa }) {
  bukaDb()
    .prepare(
      `INSERT INTO pembayaran (referensi, keterangan, nominal, status, kedaluwarsa, dibuat_pada)
       VALUES (?, ?, ?, 'PENDING', ?, ?)`
    )
    .run(referensi, keterangan ?? "", Math.round(nominal), kedaluwarsa.toISOString(), new Date().toISOString());
}

export function simpanQr(referensi, { qrContent, qrUrl, referensiDana }) {
  bukaDb()
    .prepare(`UPDATE pembayaran SET qr_content = ?, qr_url = ?, referensi_dana = ? WHERE referensi = ?`)
    .run(qrContent ?? null, qrUrl ?? null, referensiDana ?? null, referensi);
}

export function ambilPembayaran(referensi) {
  return bukaDb().prepare(`SELECT * FROM pembayaran WHERE referensi = ?`).get(referensi) ?? null;
}

/**
 * Tandai lunas hanya bila status masih PENDING dan nominal cocok.
 * Idempoten: notifikasi ganda tidak mengubah apa pun (changes = 0).
 */
export function tandaiLunas(referensi, nominal, referensiDana, waktuBayar) {
  const hasil = bukaDb()
    .prepare(
      `UPDATE pembayaran
          SET status = 'PAID',
              referensi_dana = COALESCE(?, referensi_dana),
              dibayar_pada = COALESCE(?, ?)
        WHERE referensi = ? AND status = 'PENDING' AND nominal = ?`
    )
    .run(referensiDana ?? null, waktuBayar ?? null, new Date().toISOString(), referensi, Math.round(nominal));
  return Number(hasil.changes ?? 0);
}

export function tandaiKedaluwarsa(referensi) {
  bukaDb()
    .prepare(`UPDATE pembayaran SET status = 'EXPIRED' WHERE referensi = ? AND status = 'PENDING'`)
    .run(referensi);
}

export function daftarTerbaru(batas = 20) {
  return bukaDb()
    .prepare(`SELECT * FROM pembayaran ORDER BY dibuat_pada DESC LIMIT ?`)
    .all(Math.min(Number(batas) || 20, 100));
}
