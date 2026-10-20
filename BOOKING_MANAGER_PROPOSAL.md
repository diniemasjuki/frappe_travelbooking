# Page Baharu "Booking Manager" (`manage-booking-app`)

**Ganti:** `Manage Booking Group` (`/app/manage-booking-group`)
**Modul:** Module Admin Portal · App: `travel_booking`
**Status:** DILULUSKAN & DILAKSANAKAN (Fasa 1–3) · Page live: `/app/manage-booking-app` · Tarikh: 2026-10-19

---

## 1. Ringkasan Eksekutif

Page `manage-booking-group` sedia ada berfungsi dengan baik dari segi data
(agen, batch, multi-currency, dokumen), tetapi paparannya terlalu padat —
jadual 13–14 kolum, dashboard 15 widget, dan hampir tiada penyesuaian untuk
skrin telefon. Cadangan ini menggantikannya dengan page baharu **"Booking
Manager"** yang dibina *mobile-first*: maklumat penting kekal satu tuding,
maklumat lanjut dikehedaki (progressive disclosure) melalui 3 peringkat
drill-down yang sama seperti sekarang. Tiada fungsi dibuang — hanya cara
paparan disusun semula. Page baharu ialah *standard page* (fail sumber dalam
repo app), jadi ia **ter-export bersama app** tanpa fixture atau data DB.

---

## 2. Audit Page Sedia Ada

Struktur fail (semua dalam `travel_booking/module_admin_portal/page/manage_booking_group/`):

| Fail | Saiz | Nota |
|---|---|---|
| `manage_booking_group.js` | 3,447 baris | Controller SPA 3 paparan (senarai → group/batch → booking) |
| `manage_booking_group.css` | 1,878 baris | Hanya 5 blok `@media` — majoriti rule desktop-first |
| `manage_booking_group.json` | — | Standard page, 4 role, module Module Admin Portal |

Backend: `travel_booking/api/manage_trip_booking.py` (2,108 baris, 8 method
whitelisted) — **dikekalkan seratus peratus**, tiada perubahan diperlukan.

### 2.1 Masalah utama

1. **Jadual terlalu lebar untuk telefon.** Senarai group = 13 kolum; tab
   Booking = 14 kolum; Traveller = 12; Flight = 11; Addon = 9. Satu-satunya
   penyelesaian sedia ada ialah `overflow-x: auto` — pengguna telefon
   mendatar-scroll berpuluh kali untuk satu baris.
2. **Overload maklumat pada satu skrin.** Tab Dashboard memaparkan 6 kad KPI
   + 1 carta garis masa + 8 panel carta/pecahan serentak. Booking Info
   memuat rail sticky + strip wang + 4 tab, setiap satu penuh section.
3. **Seni rupa exhaustive.** Emoji ikon pada setiap tajuk (📈🛏🏷🤝📋💳🧭🛒🎂🚻),
   badge berbilang warna bertindih, tiada hierarki visual yang tenang.
4. **Tiada progressive disclosure.** Semua maklumat dipapar serentak; tiada
   apa yang "tersembunyi" sehingga diminta.

### 2.2 Apa yang BERJAYA (dikekalkan)

- Aliran 3 peringkat: Senarai → Detail group/batch → Booking info (SPA, URL
  boleh di-bookmark).
- Disiplin multi-currency (pecahan `*_by_currency`, jumlah `≈` default
  currency) — peraturan perniagaan kritikal, tidak disentuh.
- Umpukan batch (Group Batch Name) + Assign Group Batch pukal.
- Carian lintas entiti (nombor booking, customer, traveller, stateroom).
- Muat turun: Images ZIP, Info Excel, PDF dokumen, resit Payment Entry.
- Butang Call / WhatsApp terus dari page.

---

## 3. Objektif & Prinsip Reka Bentuk

**Objektif:** interface lebih kemas, kurang seni rupa berat, dan boleh dibaca
selesa pada skrin telefon — tanpa menghilangkan sebarang kapabiliti.

| # | Prinsip | Maksud praktikal |
|---|---|---|
| 1 | **Mobile-first, desktop-second** | Setiap paparan direka pada lebar 360px dahulu; desktop hanya menambah kepadatan |
| 2 | **Progressive disclosure** | Ringkasan di hadapan; butiran di sebalik ketukan (tab, lipatan, modal) |
| 3 | **Satu skrin = satu soalan** | Senarai: "group mana?" · Detail: "kedudukan group ni?" · Booking: "kedudukan booking ni?" |
| 4 | **Kad, bukan jadual, pada telefon** | Baris jadual bertukar kepada kad bertindan berlabel (`data-label` grid); scroll mendatar dimansuhkan |
| 5 | **Visual tenang** | Tiada emoji — ikon frappe (`frappe.utils.icon`) atau tiada ikon; maksimum 1 badge utama per baris; warna hanya untuk isyarat kritikal (baki > 0, dokumen pending) |

---

## 4. Seni Bina Maklumat — 3 Peringkat

Laluan URL mengikut corak sedia ada (SPA, tanpa reload):

```
/app/manage-booking-app                      → L1  Senarai group/batch
/app/manage-booking-app/group/<name>         → L2  Detail satu group
/app/manage-booking-app/batch/<batch>        → L2  Detail umpukan batch
/app/manage-booking-app/booking/<name>       → L3  Info satu booking
```

### L1 — Senarai (telefon)

```
┌──────────────────────────────────────┐
│ ⌕ Cari group / trip / booking...     │
│                                      │
│ (Semua 12)(Akan Datang 5)(Lewat 7)  │  ← chip skrol-x, kiraan semasa
│ ⚙ Penapis lanjut                     │  ← bottom sheet: status, tahun/
│                                      │    bulan, jenis trip, hide passive
├──────────────────────────────────────┤
│ RM 820,100 · 96 booking · 210 pax    │  ← strip jumlah (ganti tfoot)
├──────────────────────────────────────┤
│ ┌──────────────────────────────────┐ │
│ │ TG-2026-001   [Active]      ☐    │ │  ← kod/batch + 1 badge + pilih
│ │ Borneo Cruise 4D3N               │ │
│ │ 12 Jan → 15 Jan 2026             │ │
│ │ 24 booking · 60 pax · RM 41,200  │ │  ← 3 stat mini sebaris
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ BATCH-AROYA-01  [Running]  (3) ☐ │ │  ← batch: bilangan group
│ │ ...                              │ │
└──────────────────────────────────────┘
```

- Ketukan kad → L2. Ketukan ☐ → pilih untuk Assign Group Batch (butang
  terapung bawah `Assign Batch (n)` apabila ≥1 dipilih).
- **Desktop (≥992px):** jadual padat **7 kolum** sahaja — Group/Batch (badge
  bilangan) · Trip · Status · Departure · Bookings · Revenue · Balance.
  Rooms / Pax / Docs / Collection % berpindah ke baris sub-dalam-sel dan
  tooltip — kolum "bagus untuk tahu" tidak lagi menyalarkan jadual.

### L2 — Detail Group/Batch

```
┌──────────────────────────────────────┐
│ ← Booking Manager                    │
│ TG-2026-001                 [Active] │
│ Borneo Cruise 4D3N · 12–15 Jan 2026  │
│ (batch: senarai chip group anggota)  │
├──────────────────────────────────────┤
│ [Ikhtisar][Booking][Tetamu][Bilik][Lagi] │ ← segmented, skrol-x
├──────────────────────────────────────┤
│ Ikhtisar — KPI 2×2 (telefon):        │
│ ┌───────────┐ ┌───────────┐          │
│ │ Bookings  │ │ Revenue   │          │
│ │ 24        │ │ RM 41,200 │          │
│ └───────────┘ └───────────┘          │
│ ┌───────────┐ ┌───────────┐          │
│ │ Baki      │ │ Docs      │          │
│ │ RM 9,800  │ │ 4 pending │          │
│ └───────────┘ └───────────┘          │
│ Occupancy 60/76 · Addon RM 2,300     │  ← baris kecil, bukan kad
│                                      │
│ 📈 Revenue Timeline (penuh lebar)    │  ← kekal, tinggi 180
│                                      │
│ ▸ Analitik (lipatan, tertutup)       │  ← 8 pie → bar mendatar
│   • Status booking   ▇▇▇▇▇ 24        │
│   • Status payment   ▇▇▇ 24          │
│   • Umur / Jantina / Saluran / ...   │
└──────────────────────────────────────┘
```

- **8 pie chart → bar mendatar berlabel** di dalam section **Analitik** yang
  *tertutup secara default pada telefon* (terbuka pada desktop). Bar teks
  lebih mudah dibaca berbanding pie, jimat ruang, dan kekal berfungsi tanpa
  carta bila perlu.
- Tab **Booking**: telefon = kad ringkas (No + status badge · customer ·
  baki), ketukan → L3; desktop = jadual 8 kolum (kolum Created & Discount
  pindah ke L3 sahaja).
- Tab **Tetamu**: kekalkan grid kad sedia ada (sudah mesra telefon) +
  tapis status dokumen; jadual penuh hanya pada desktop.
- Tab **Bilik (Rooming)**: senarai lipat per bilik (`details/summary`) —
  kepala 1 baris: `Room ID · kategori · docs 2/2 · [badge]`; kandungan =
  senarai tetamu.
- Tab **Lagi**: Addon & Flight sebagai dua sub-bahagian ringkas (eks-tab),
  supaya tab utama kecil dan tetap.

### L3 — Booking Info

- **Telefon:** rail sticky **dibuang** → satu lajur:
  1. Kad identiti (No booking · status · bar progres bayaran)
  2. Strip wang `Order → Paid → Baki` + Payment Status (kekalkan — kritikal)
  3. 4 tab sedia ada: Ikhtisar · Tetamu · Dokumen · Lain-lain
- **Desktop:** kekalkan konsep rail sedia ada (ia berkesan pada skrin besar).
- Ikhtisar: Order Summary + chips + Timeline — timeline dipendekkan
  (5 peristiwa terkini + butang "Tunjuk semua").
- Dokumen/Tetamu: kekalkan format kad sedia ada (sudah sesuai telefon);
  butang Images ZIP / Info Excel kekal.

---

## 5. Struktur Direktori (Export-Ready)

```
travel_booking/travel_booking/module_admin_portal/page/manage_booking_app/
├── __init__.py
├── manage_booking_app.json     # doctype Page — standard:"Yes", module:"Module Admin Portal"
├── manage_booking_app.js       # controller SPA 3 paparan (sasaran < 2,000 baris)
└── manage_booking_app.css      # mobile-first (sasaran < 1,000 baris)
```

**Mengapa ini ter-export bersama app:** sama seperti page sedia ada, ia ialah
*standard page* — fail sumber dalam repo. Semasa `bench get-app` + `bench
install-app` / `bench migrate`, Frappe sync page daripada fail ini; tiada
rekod DB atau fixture diperlukan. Syarat penting: page **mesti dicipta
sebagai fail dalam repo** (seperti corak sedia ada), BUKAN melalui UI
("New Page" di desk) — page ciptaan UI ialah *custom page* yang hidup dalam
DB dan memerlukan `export-fixtures` untuk ikut app.

Skelton `manage_booking_app.json`:

```json
{
 "doctype": "Page",
 "module": "Module Admin Portal",
 "name": "manage-booking-app",
 "page_name": "manage-booking-app",
 "title": "Booking Manager",
 "standard": "Yes",
 "system_page": 1,
 "roles": [
  {"role": "System Manager"},
  {"role": "Tour Manager"},
  {"role": "Tour Operator"},
  {"role": "Accounts User"}
 ]
}
```

**Backend:** guna semula `travel_booking.api.manage_trip_booking`
(`get_trip_groups`, `get_group_dashboard`, `get_group_bookings`,
`get_group_addons`, `get_group_flights`, `get_group_travellers`,
`get_group_rooming`, `get_booking_profile`, `assign_group_batch`,
`download_*`). Tiada perubahan doctype / skema DB. Sekiranya perlu, medan
kecil ditambah pada respons sedia ada (cth. agregat untuk strip jumlah L1) —
kekalan backward-compatible.

---

## 6. Perubahan Visual — Sebelum / Selepas

| Aspek | Sedia ada | Booking Manager |
|---|---|---|
| Senarai pada telefon | Jadual 13 kolum, scroll mendatar | Kad menegak, 0 scroll mendatar |
| Kolum desktop senarai | 13 | 7 (+ butiran dalam sel) |
| Widget dashboard | 15 widget serentak | 4 KPI + 1 carta + analitik lipatan |
| Carta pai | 8 panel | Bar mendatar berlabel (lipatan) |
| Ikon tajuk | Emoji pelbagai | Ikon frappe / tiada ikon |
| Badge per baris | Banyak (2–4) | 1 utama (+ 1 kritikal sahaja) |
| Booking info telefon | Rail sticky + strip + 4 tab | 1 lajur: kad → strip → 4 tab |
| Saiz JS/CSS | 3,447 + 1,878 baris | sasaran < 2,000 + < 1,000 baris |

---

## 7. Housekeeping Berkaitan (cadangan)

1. Buang direktori terbiar `travel_booking/module_travel_booking x/` (nama
   mengandungi ruang — kelihatan kemalangan).
2. Semasa peralihan, aliaskan route lama: ketukan pautan
   `/app/manage-booking-group/...` dialih ke padanan `/app/manage-booking-app/...`
   (boleh dibuat dalam `on_page_load` page lama yang kekal sementara).
3. Page lama **dikekalkan 1–2 minggu** selepas Booking Manager siap (roll-back
   mudah), kemudian dipadam bersama CSS-nya.

---

## 8. Pelan Pelaksanaan

| Fasa | Kandungan | Usaha |
|---|---|---|
| 0 | Kelulusan reka bentuk (dokumen ini) | — |
| 1 | Kerangka page + L1 (kad telefon + jadual desktop + penapis + strip jumlah + assign batch) | 1–2 hari |
| 2 | L2 detail (header padat, 5 tab, KPI 2×2, timeline, analitik lipatan) | 2 hari |
| 3 | L3 booking info responsif (kad identiti, strip, 4 tab, timeline ringkas) | 1–2 hari |
| 4 | QA telefon sebenar (iOS Safari + Android Chrome), ujian role, alih pautan, perantaraan route lama | 1 hari |

Jumlah anggaran: **5–7 hari kerja**. Tiada risiko data — backend & doctype
tidak diubah; risiko tunggal ialah perbezaan kebiasaan pengguna, yang
dirawat dengan tempoh peralihan (Fasa 4).

---

## 9. Checklist Penerimaan

- [ ] Sifar scroll mendatar pada lebar 360px untuk semua paparan utama (L1/L2/L3).
- [ ] Semua sasaran ketukan ≥ 44×44px (ibu jari).
- [ ] Semua fungsi sedia ada wujud: carian lintas entiti, penapis, umpukan
      batch, 6 set data tab, multi-currency, muat turun ZIP/Excel/PDF/resit,
      Call/WhatsApp, perutusan customer.
- [ ] Page muncul pada site baharu selepas `bench get-app` + `install-app`
      tanpa langkah manual (uji export).
- [ ] Nombor & badge konsisten dengan disiplin currency sedia ada (tiada
      penjumlahan merentas currency).
