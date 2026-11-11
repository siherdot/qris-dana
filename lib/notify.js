import { stringToSignTransaksi, verifikasi } from "./tanda.js";

/**
 * Verifikasi webhook "Finish Notify" dari DANA.
 *
 * Tanpa verifikasi ini siapa pun bisa POST dan menandai tagihan lunas.
 * String yang ditandatangani memakai path relatif tanpa query: /v1.0/debit/notify.
 */
export const PATH_NOTIFY = "/v1.0/debit/notify";

export function verifikasiWebhook({ signature, timestamp, body, path }, publicKeyPem) {
  if (!signature || !timestamp) return false;
  return verifikasi(stringToSignTransaksi("POST", path, body, timestamp), signature, publicKeyPem);
}

/** "00" = sukses/dibayar, "05" = batal/kedaluwarsa. */
export function sudahDibayar(notif) {
  return notif.latestTransactionStatus === "00";
}
