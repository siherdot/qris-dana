import { randomUUID } from "node:crypto";
import { stringToSignToken, stringToSignTransaksi, tanda, timestampWib } from "./tanda.js";

/**
 * Klien DANA Open API (SNAP) untuk QRIS MPM (Acquirer).
 *
 * POST /v1.0/access-token/b2b.htm      -> access token (~15 menit)
 * POST /v1.0/qr/qr-mpm-generate.htm    -> QRIS dinamis bernominal
 * POST /rest/v1.1/debit/status         -> cek status (serviceCode 47)
 * POST /v1.0/debit/notify              -> webhook masuk (lihat notify.js)
 */

export class DanaError extends Error {
  constructor(message, responseCode, status, mentah) {
    super(message);
    this.name = "DanaError";
    this.responseCode = responseCode;
    this.status = status;
    this.mentah = mentah;
  }
}

let cacheToken = null;

async function ambilToken(k) {
  if (cacheToken && cacheToken.kedaluwarsa > Date.now() + 30_000) return cacheToken.nilai;

  const path = "/v1.0/access-token/b2b.htm";
  const timestamp = timestampWib();
  const body = JSON.stringify({ grantType: "client_credentials" });

  const res = await fetch(k.baseUrl + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-TIMESTAMP": timestamp,
      "X-CLIENT-KEY": k.clientId,
      "X-SIGNATURE": tanda(stringToSignToken(k.clientId, timestamp), k.privateKey),
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.accessToken) {
    throw new DanaError(
      data.responseMessage ?? "Gagal mengambil access token DANA",
      String(data.responseCode ?? res.status),
      res.status,
      data
    );
  }

  const detik = Number(data.expiresIn ?? 900) || 900;
  cacheToken = { nilai: data.accessToken, kedaluwarsa: Date.now() + detik * 1000 };
  return data.accessToken;
}

/**
 * Panggil endpoint transaksi. Body di-stringify SEKALI: string yang sama
 * dipakai untuk hash tanda tangan dan untuk dikirim. Stringify ulang = 401.
 */
async function panggil(k, method, path, payload) {
  const token = await ambilToken(k);
  const body = JSON.stringify(payload);
  const timestamp = timestampWib();

  const res = await fetch(k.baseUrl + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-TIMESTAMP": timestamp,
      "X-SIGNATURE": tanda(stringToSignTransaksi(method, path, body, timestamp), k.privateKey),
      "X-PARTNER-ID": k.clientId,
      "X-EXTERNAL-ID": randomUUID(),
      "CHANNEL-ID": k.channelId,
      ORIGIN: k.origin,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  const data = await res.json().catch(() => ({}));
  const kode = String(data.responseCode ?? res.status);
  if (!res.ok || !kode.startsWith("200")) {
    throw new DanaError(
      String(data.responseMessage ?? "Permintaan ke DANA gagal"),
      kode,
      res.status,
      data
    );
  }
  return data;
}

/** Nomor referensi unik, maksimal 25 karakter (batas khusus QRIS). */
export function nomorReferensi(prefix = "INV") {
  const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  const acak = randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
  return `${prefix}${stamp}${acak}`.slice(0, 25);
}

export async function buatQris(k, { nominal, partnerReferenceNo, berlakuMenit = 30 }) {
  const ref = partnerReferenceNo ?? nomorReferensi();
  const kedaluwarsa = new Date(Date.now() + berlakuMenit * 60_000);

  const hasil = await panggil(k, "POST", "/v1.0/qr/qr-mpm-generate.htm", {
    merchantId: k.merchantId,
    storeId: k.storeId,
    partnerReferenceNo: ref,
    amount: { value: nominal.toFixed(2), currency: "IDR" },
    validityPeriod: timestampWib(kedaluwarsa),
    additionalInfo: {
      envInfo: { sourcePlatform: "IPG", orderTerminalType: "WEB", terminalType: "WEB" },
    },
  });

  return {
    partnerReferenceNo: ref,
    referenceNo: hasil.referenceNo,
    qrContent: hasil.qrContent,
    qrUrl: hasil.qrUrl,
    merchantName: hasil.merchantName,
    kedaluwarsa,
  };
}

export async function cekStatus(k, { partnerReferenceNo, referenceNo }) {
  return panggil(k, "POST", "/rest/v1.1/debit/status", {
    originalPartnerReferenceNo: partnerReferenceNo,
    originalReferenceNo: referenceNo ?? "",
    merchantId: k.merchantId,
    serviceCode: "47",
  });
}
