/** Konfigurasi dari environment. Fitur mati rapi (503) bila belum lengkap. */

const BASE_URL = {
  sandbox: "https://api.sandbox.dana.id",
  production: "https://api.saas.dana.id",
};

function rapikanPem(nilai) {
  return nilai ? nilai.replace(/\\n/g, "\n") : undefined;
}

export function konfigurasiDariEnv() {
  const clientId = process.env.DANA_CLIENT_ID;
  const merchantId = process.env.DANA_MERCHANT_ID;
  const storeId = process.env.DANA_STORE_ID;
  const privateKey = rapikanPem(process.env.DANA_PRIVATE_KEY);
  if (!clientId || !merchantId || !storeId || !privateKey) return null;

  const env = process.env.DANA_ENV === "production" ? "production" : "sandbox";

  return {
    env,
    clientId,
    merchantId,
    storeId,
    privateKey,
    publicKey: rapikanPem(process.env.DANA_PUBLIC_KEY),
    origin: process.env.DANA_ORIGIN ?? "http://localhost:3000",
    channelId: process.env.DANA_CHANNEL_ID ?? "95221",
    baseUrl: (process.env.DANA_BASE_URL ?? BASE_URL[env]).replace(/\/$/, ""),
  };
}

export function sudahDikonfigurasi() {
  return konfigurasiDariEnv() !== null;
}
