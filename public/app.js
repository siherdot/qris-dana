const rupiah = (n) => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(n);
const waktu = (iso) => (iso ? new Date(iso).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" }) : "—");

const el = (id) => document.getElementById(id);
let referensiAktif = null;
let pengaturWaktu = null;

const LABEL_STATUS = {
  PENDING: "Menunggu pembayaran",
  PAID: "Lunas",
  EXPIRED: "Kedaluwarsa",
  CANCEL: "Dibatalkan",
};

function tampilkanStatus(status) {
  const kotak = el("status");
  kotak.textContent = LABEL_STATUS[status] ?? status;
  kotak.dataset.status = status;
}

async function muatKesehatan() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    if (!data.dana) el("peringatan").hidden = false;
  } catch {
    /* biarkan */
  }
}

async function muatRiwayat() {
  try {
    const res = await fetch("/api/pembayaran?batas=10");
    const data = await res.json();
    const isi = el("riwayat");
    if (!data.ok || data.data.length === 0) {
      isi.innerHTML = '<tr><td colspan="4" class="kosong">Belum ada tagihan.</td></tr>';
      return;
    }
    isi.innerHTML = data.data
      .map(
        (b) => `<tr>
          <td class="mono">${b.referensi}</td>
          <td>${rupiah(b.nominal)}</td>
          <td><span class="pil" data-status="${b.status}">${LABEL_STATUS[b.status] ?? b.status}</span></td>
          <td>${waktu(b.dibuat_pada)}</td>
        </tr>`
      )
      .join("");
  } catch {
    /* biarkan */
  }
}

function mulaiPantau(referensi) {
  clearInterval(pengaturWaktu);
  referensiAktif = referensi;
  pengaturWaktu = setInterval(async () => {
    if (!referensiAktif) return;
    try {
      const res = await fetch(`/api/qris/${encodeURIComponent(referensiAktif)}?cek=1`);
      const data = await res.json();
      if (!data.ok) return;
      tampilkanStatus(data.status);
      if (data.status !== "PENDING") {
        clearInterval(pengaturWaktu);
        pengaturWaktu = null;
        muatRiwayat();
      }
    } catch {
      /* coba lagi di tick berikutnya */
    }
  }, 4000);
}

el("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const tombol = el("tombol");
  const galat = el("galat");
  galat.hidden = true;
  tombol.disabled = true;
  tombol.textContent = "Membuat…";

  try {
    const res = await fetch("/api/qris", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nominal: Number(el("nominal").value),
        keterangan: el("keterangan").value,
      }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      galat.textContent = data.pesan ?? "Gagal membuat QRIS.";
      galat.hidden = false;
      return;
    }

    el("gambar").src = data.qrDataUrl;
    el("r-nominal").textContent = rupiah(data.nominal);
    el("r-referensi").textContent = data.referensi;
    el("r-kedaluwarsa").textContent = waktu(data.kedaluwarsa);
    el("hasil").hidden = false;
    tampilkanStatus("PENDING");
    mulaiPantau(data.referensi);
    muatRiwayat();
  } catch {
    galat.textContent = "Tidak dapat menghubungi server.";
    galat.hidden = false;
  } finally {
    tombol.disabled = false;
    tombol.textContent = "Buat QRIS";
  }
});

muatKesehatan();
muatRiwayat();
