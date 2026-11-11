/**
 * Utilitas QRIS (EMVCo TLV) — dipakai untuk dua hal:
 * 1. Memeriksa isi QR sebelum ditampilkan (nominal, NMID).
 * 2. Mengubah QRIS statis milik sendiri menjadi dinamis (menyisipkan tag 54).
 *
 * Konversi statis->dinamis TIDAK memberi status pembayaran; itu hanya untuk
 * tampilan/manual. Alur utama memakai API acquirer (lihat klien.js).
 */

/** Pecah string QRIS menjadi daftar TLV level atas. */
export function parseTlv(payload) {
  const hasil = [];
  let i = 0;
  while (i + 4 <= payload.length) {
    const id = payload.slice(i, i + 2);
    const panjang = Number(payload.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(id) || !Number.isInteger(panjang)) {
      throw new Error(`QRIS tidak valid pada posisi ${i}`);
    }
    const value = payload.slice(i + 4, i + 4 + panjang);
    if (value.length !== panjang) throw new Error(`Panjang tag ${id} tidak cocok`);
    hasil.push({ id, value });
    i += 4 + panjang;
  }
  if (i !== payload.length) throw new Error("QRIS punya sisa byte yang tidak terbaca");
  return hasil;
}

export function rakitTlv(tags) {
  return tags.map((t) => `${t.id}${String(t.value.length).padStart(2, "0")}${t.value}`).join("");
}

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, tanpa refleksi. */
export function crc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** Hitung ulang tag 63 (CRC) dari payload tanpa CRC. */
export function denganCrc(payloadTanpaCrc) {
  const tanpaTag63 = payloadTanpaCrc.endsWith("6304") ? payloadTanpaCrc.slice(0, -4) : payloadTanpaCrc;
  const dasar = `${tanpaTag63}6304`;
  return `${dasar}${crc16(dasar)}`;
}

export function tanpaCrc(payload) {
  return rakitTlv(parseTlv(payload).filter((t) => t.id !== "63"));
}

/** Rupiah bulat tanpa desimal; selain itu dua desimal. */
export function nominalQris(nominal) {
  if (!Number.isFinite(nominal) || nominal <= 0) throw new Error("Nominal harus lebih dari 0");
  const bulat = Math.round(nominal * 100) / 100;
  return Number.isInteger(bulat) ? String(bulat) : bulat.toFixed(2);
}

/** QRIS statis -> dinamis: tag 54 disisipkan setelah 53, sebelum 55. */
export function qrisDinamis(qrisStatis, nominal) {
  const tags = parseTlv(tanpaCrc(qrisStatis)).filter((t) => t.id !== "54");
  const baru = { id: "54", value: nominalQris(nominal) };
  const posisi = tags.findIndex((t) => Number(t.id) > 54);
  if (posisi === -1) tags.push(baru);
  else tags.splice(posisi, 0, baru);
  return denganCrc(rakitTlv(tags));
}

export function bacaNominal(payload) {
  const tag = parseTlv(payload).find((t) => t.id === "54");
  if (!tag) return null;
  const n = Number(tag.value);
  return Number.isFinite(n) ? n : null;
}

export function crcValid(payload) {
  if (payload.length < 8) return false;
  return crc16(`${payload.slice(0, -8)}6304`) === payload.slice(-4).toUpperCase();
}

/** Ringkasan isi QR untuk log/audit. */
export function ringkasQris(payload) {
  const tags = parseTlv(payload);
  const ambil = (id) => tags.find((t) => t.id === id)?.value ?? null;
  return {
    metode: ambil("01"),
    merchant: ambil("59"),
    kota: ambil("60"),
    nominal: ambil("54"),
    mataUang: ambil("53"),
    negara: ambil("58"),
  };
}
