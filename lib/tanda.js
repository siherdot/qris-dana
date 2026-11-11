import { createHash, sign, verify } from "node:crypto";

/**
 * Tanda tangan DANA Open API (SNAP), skema Asymmetric Signature:
 * RSA-2048 + SHA-256, hasilnya base64.
 *
 * - Request kita ditandatangani dengan private key kita; DANA memverifikasi
 *   dengan public key yang kita unggah di Merchant Portal.
 * - Webhook DANA ditandatangani dengan private key DANA; kita verifikasi
 *   dengan public key DANA.
 */

/** Waktu WIB: YYYY-MM-DDTHH:mm:ss+07:00, tanpa milidetik. */
export function timestampWib(waktu = new Date()) {
  const wib = new Date(waktu.getTime() + 7 * 60 * 60 * 1000);
  const dua = (n) => String(n).padStart(2, "0");
  return (
    `${wib.getUTCFullYear()}-${dua(wib.getUTCMonth() + 1)}-${dua(wib.getUTCDate())}` +
    `T${dua(wib.getUTCHours())}:${dua(wib.getUTCMinutes())}:${dua(wib.getUTCSeconds())}+07:00`
  );
}

/** SHA-256 hex huruf kecil dari body yang PERSIS dikirim. */
export function hashBody(body) {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function stringToSignToken(clientId, timestamp) {
  return `${clientId}|${timestamp}`;
}

export function stringToSignTransaksi(method, path, body, timestamp) {
  return `${method.toUpperCase()}:${path}:${hashBody(body)}:${timestamp}`;
}

export function tanda(stringToSign, privateKeyPem) {
  return sign("RSA-SHA256", Buffer.from(stringToSign, "utf8"), privateKeyPem).toString("base64");
}

export function verifikasi(stringToVerify, signatureBase64, publicKeyPem) {
  try {
    return verify(
      "RSA-SHA256",
      Buffer.from(stringToVerify, "utf8"),
      publicKeyPem,
      Buffer.from(signatureBase64, "base64")
    );
  } catch {
    return false;
  }
}
