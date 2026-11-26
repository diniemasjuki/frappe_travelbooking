# Laporan Audit GUI Black-Box — Rarecation (trip.rarecation.com & cruise.rarecation.com)

**Tarikh audit:** 2–3 Nov 2026 (sesi UTC 19:35–19:50)
**Kaedah:** GUI black-box tulen mengikut metodologi web-gui-tester — tindakan → pemerhatian → tindakan. Setiap langkah = satu skrip Playwright headless (chromium.launchPersistentContext, profil `browser-profile` mengekalkan cookies login). Setiap keadaan disahkan dengan **screenshot full-page (dibaca semula) + ariaSnapshot DOM (dibaca semula)**. Tiada injection JS berkesan sampingan, tiada bypass URL untuk lari daripada kegagalan, tiada refresh escape. Console listener tahap error (baca-sahaja) didaftarkan dari awal.

**Akaun test:** gui.audit.test@rarecation.com (login dibenarkan). **Tiada booking/pembayaran dicipta** — wizard dihentikan pada Step 3 (Payment); butang "Pay Now — RM 6,440.00" TIDAK diklik.

**Nota tooling:** Tooling browser rasmi sesi (node_repl MCP) tiada; digantikan dengan Playwright headless di `/home/frappe/gui-audit-workspace/driver` seperti diarahkan. Skrip di `/home/frappe/gui-audit-workspace/scripts/`, snapshot DOM di `scripts/snapshots/`. Screenshot lama dari sesi terdahulu (`t1_*`–`t7_*`, `dbg*`, `e*`, `login_*`, `guidbg*`) TIDAK sebahagian audit ini; audit ini menggunakan fail `t01_*`–`t22_*` sahaja.

---

## 1. Inventori Halaman (route → screenshot → pemerhatian)

| # | Route / Keadaan | Screenshot | Pemerhatian utama |
|---|---|---|---|
| 1 | `/` homepage (trip vertical, 1440px) | gui-test-screenshots/t01_home.png | Hero "Explore the World Beyond the Seas", carian Destination/Departure, statistik "300+ Tours / 40+ Countries / 95% Happy Travellers", seksyen **"No featured tours yet"** (empty state), testimoni, footer penuh (Affiliate, T&C ×2, Cabin Crew→/desk, contact WhatsApp). Nav: Tour→`/`, Cruise→cruise.rarecation.com, All Trip→`/trips`, Currency MYR/SGD, Manage Booking→`/traveller`. Widget chat terapung. |
| 2 | `/trips` katalog | gui-test-screenshots/t02_trips.png | "17 trips found" — semuanya produk cruise Mediterranean (Cruise Only / Fly Cruise). Penapis: carian, Destination (17 opsyen), Item group (hanya "All groups"), Type, From/To, Sort by; butang Search + Reset. Kad: ports, durasi, tarikh sail, "Open pax", harga "From RM2,990", EARLY BIRD (harga coret). Nav halaman ini berbeza: Cruise→`/`, Destination→`/cruises`, Schedule→`/cruise-schedule`. |
| 3 | `/trip2622` detail trip | gui-test-screenshots/t03_trip_detail.png | "Cruise Only : Roundtrip from Istanbul" — galeri 5 gambar + "+9 more photos", deskripsi, Highlights, Included/Excluded, Itinerary 8 hari (accordion terbuka), FAQ. Sidebar "Reserve Your Activity": "Start from RM2,990 / person", 2 butang pakej (2 dates From RM3,220 / 9 dates From RM2,990), radio sailing 14 Nov 2026 [checked], "Main Guest from RM 3,220", **Book Now**, "Charged in MYR", teks "Price is varies base on current flight price" (pada pakej cruise-only). "You may also like" 3 kad. |
| 4 | `/traveller` login | gui-test-screenshots/t04_login.png | "Welcome Back — Sign in to manage your bookings". Medan Email + Password, butang "Sign In with Password", alternatif "Sign In without Password" (magic link) + Google. Pautan kembali ke laman utama. |
| 5 | Selepas login → `/traveller/bookings` | gui-test-screenshots/t05_after_login.png (transien: t05_login_transient.png — tiada toast ketara, login pantas terus ke portal) | Login berjaya dengan akaun test; redirect ke portal. Nav portal: My Bookings / My Transactions / My Profile / menu pengguna (initial "GA"). Empty state "No Bookings Yet" + CTA "Browse Trips". |
| 6 | `/booknow` wizard Step 1 | gui-test-screenshots/t06_wizard_step1.png | Stepper 4 langkah (Rooms & Passengers → Billing Info → Payment → Confirm). Konteks: TRIP2622, Group 14–21 Nov 2026, Cruise Only, Embarkation Istanbul. Room 1 + "Select rooming type" + "Add another room". Summary: Total Guests 0, Total RM 0.00, Deposit (5%) RM 0.00. **Continue disabled** (perlukan main guest). |
| 7 | Dialog "Choose Your Room" | gui-test-screenshots/t07_rooming_open.png | Modal pilih bilik: carian nama bilik, penapis All/Cabin/Suite, 6 jenis (Interior RM3,220 → Seaview RM3,850 → Seaview Superior RM4,250 → Balcony RM4,940 → Balcony Superior RM5,460 → Superior Suite Khuzama RM6,620 per pax), butang "Play room video" + "Select This Room" setiap satu. |
| 8 | Step 1 — bilik dipilih | gui-test-screenshots/t08_room_selected.png | Interior Cabin dipilih (Capacity 2-3 Pax, butang "Change"). Stepper Main Guest RM3,220/pax aktif; Extra Bed & Infant RM0.00 (stepper disabled sehingga main guest ditambah). Summary masih RM0.00. |
| 9 | Step 1 — 2 penumpang | gui-test-screenshots/t09_guests_added.png | Main Guest = 2 ("+" kini disabled; Extra Bed "+" kini enabled — pax ke-3 via sofa bed). Summary: "Interior Cabin (1) + Guest 1: Main Guest RM 3,220.00 + Guest 2: Main Guest RM 3,220.00", **Total RM 6,440.00, Deposit (5%) RM 322.00** (kiraan tepat). Continue enabled. |
| 10 | Step 2 Billing Info | gui-test-screenshots/t10_billing_step2.png | Email **prefilled** gui.audit.test@rarecation.com ("Verified (signed in)" + "Change email"), Full Name **prefilled** "GUI AUDIT TEST", negara telefon Malaysia +60. Street/City/Postcode/State kosong; **Country dropdown tidak prefilled** ("Select country"). Summary kekal RM6,440 / RM322. Continue disabled sehingga wajib diisi. |
| 11 | Step 2 — borang diisi | gui-test-screenshots/t11_billing_filled.png | Semua medan diisi (data dummy audit); nombor telefon auto-format "12-345 6789"; Country = Malaysia. |
| 12 | Step 3 Payment (**BERHENTI di sini**) | gui-test-screenshots/t12_payment_step3.png | "Payment Amount" RM 6,440 (spinbutton boleh edit, "Tap to enter a custom amount"). 3 kaedah: Online Payment (Visa/Mastercard, checked), Manual Transfer (3-5 hari kerja), Held Booking (tempah dulu, bayar via portal). "Message to Us" (0/1000). Voucher Code + Affiliate Referral Code (butang Apply). Total RM6,440.00, Deposit (5%) RM322.00. Butang "**Pay Now — RM 6,440.00**" — TIDAK diklik (peraturan keselamatan data). |
| 13 | `/traveller/bookings` (dedicated) | gui-test-screenshots/t13_bookings.png | Sama seperti #5 — empty state disahkan semula melalui klik nav "Manage Booking" dari homepage (sesi login kekal). |
| 14 | `/traveller/profile` | gui-test-screenshots/t14_profile.png | Account Information (Full Name, Email sign-in read-only, Phone "Not set", butang "Edit →"), Change Password, seksyen **PDPA Data Rights** (Data Correction / Account Deletion + Submit Request — tidak dihantar). |
| 15 | `/trips` + Destination=Istanbul | gui-test-screenshots/t15a_filter_changed.png, t15_filter_istanbul.png | (a) Memilih dropdown sahaja **menukar URL** (`?destination=Istanbul`) tetapi **senarai tidak berubah** (masih 17 kad) sehingga Search diklik. (b) Selepas Search: masih 17 trips — semua trip sememangnya mengandungi Istanbul sebagai pelabuhan. |
| 16 | `/trips` + Destination=Sarajevo | gui-test-screenshots/t15c_filter_sarajevo.png | Selepas Search: "**0 trips found**" + empty state "No trips match your filters" — penapis berfungsi, tetapi opsyen Sarajevo tiada inventori. |
| 17 | `/trips` currency SGD | gui-test-screenshots/t16_currency_before.png → t16_currency_after.png | Tukar navbar Currency MYR→SGD: URL `?currency=SGD`, harga kad bertukar ke `$` (cth. "From $1,040"). Mata wang **berkekalan** merentasi halaman (lihat #18). Sila lihat §4 untuk percanggahan harga yang diperhati. |
| 18 | `/cruise-schedule` | gui-test-screenshots/t17_cruise_schedule.png | "17 sailings across 17 cruises", dikelompok mengikut bulan (Nov 2026 → …). Kad sailing: tarikh, ports, durasi, kapal "Aroya", "From $1,040 per person", status Available, **Book Now** + View Details. Penapis: carian, Destination, bulan & tahun sailing. **Tiada sailing 14 Nov 2026** walaupun kad /trips MYR & wizard menunjukkannya (lihat §3/§4). |
| 19 | `/traveller/transactions` | gui-test-screenshots/t18_transactions.png | "Transaction History" — empty state "No Transactions Yet", pemilih rows-per-page (10/20/50/100), penapis status (All/Verified/Pending/Cancelled). |
| 20 | `/traveller/billing` | gui-test-screenshots/t19_billing.png | "Booking reference missing." + pautan "← Back to My Bookings" (jangkaan: tiada booking). Avatar menu pengguna papar **"?"** (vs "GA" di halaman portal lain). |
| 21 | `/traveller/booking_addons` | gui-test-screenshots/t19_booking_addons.png | **Redirect** ke `/traveller/bookings` (tiada rujukan booking). |
| 22 | `/booking-terms` | gui-test-screenshots/t20_booking_terms.png | **Placeholder sahaja**: "Our booking Terms & Conditions are currently being updated. Please check back later or contact us for the latest copy." Nav halaman ini **tiada** pemilih Currency (halaman awam lain ada). |
| 23 | `https://cruise.rarecation.com/` | gui-test-screenshots/t21_cruise_home.png | **Halaman maintenance**: "We'll be right back — This site is undergoing scheduled maintenance." Logo bertulis "RareCruise by Rarecattion Travel" (typo "Rarecattion"). Konsol: 503 SERVICE UNAVAILABLE. |
| 24 | `/` homepage @ 390px | gui-test-screenshots/t22_home_390px.png | scrollWidth=clientWidth=390 → **tiada horizontal overflow**. Navbar wrap ke 2 baris (baris 1: logo + Currency + Manage Booking; baris 2: Tour/Cruise/All Trip), tiada hamburger, semua pautan kekal kelihatan & boleh diklik (semakan geometri baca-sahaja: tiada pertindihan rect). |

---

## 2. Funnel Trace — homepage hingga wizard Step 3 (langkah demi langkah)

1. **Homepage** (`t01_home.png`): pengguna mendarat di hero dengan carian. Klik nav **"All Trip"**.
2. **Katalog** (`t02_trips.png`): 17 kad trip dipaparkan. Klik kad pertama ("Cruise Only : Roundtrip from Istanbul").
3. **Detail trip** (`t03_trip_detail.png`): sidebar tempahan memaparkan pakej & tarikh sailing (default: radio 14 Nov 2026, "Main Guest from RM 3,220"). Klik **Book Now**.
4. **Wizard Step 1** (`t06_wizard_step1.png`): stepper 4 langkah; Continue disabled pada 0 tetamu.
5. Klik **"Select rooming type"** → modal bilik (`t07_rooming_open.png`): 6 kabin dengan harga/pax.
6. Klik **"Select This Room"** (Interior Cabin) (`t08_room_selected.png`): borang stepper pax muncul.
7. Klik **"+"** dua kali → 2 Main Guest (`t09_guests_added.png`): Total RM 6,440.00, Deposit (5%) RM 322.00; Continue enabled. Klik **Continue**.
8. **Wizard Step 2 Billing** (`t10_billing_step2.png`): email & nama **prefilled** dari akaun (Verified); alamat kosong; Country tidak prefilled.
9. Isi alamat dummy + pilih Country=Malaysia (`t11_billing_filled.png`); telefon auto-format. Klik **Continue**.
10. **Wizard Step 3 Payment** (`t12_payment_step3.png`): amaun RM6,440 (boleh edit), 3 kaedah pembayaran, medan mesej, kod baucar/afiliasi, summary Total RM6,440.00 + Deposit RM322.00.
11. **BERHENTI** — butang "Pay Now — RM 6,440.00" tidak diklik; tiada dokumen Booking/Sales Order/Payment dicipta. (Step 4 Confirm tidak dimasuki.)

**Keputusan funnel:** laluan tempahan berfungsi hingga Step 3 tanpa ralat; kiraan harga & deposit tepat; prefilled billing berfungsi untuk email/nama tetapi tidak untuk alamat & negara.

---

## 3. Geseran UX (diperhati, dengan bukti)

1. Memilih Destination pada `/trips` menukar URL serta-merta tetapi senarai hasil **tidak berubah** sehingga butang Search diklik — dua tingkah laku bercampur dalam satu borang penapis (t15a_filter_changed.png vs t15_filter_istanbul.png).
2. Harga kad SGD tidak konsisten dengan harga MYR kad yang sama — nisbah tukar berbeza antara kad: RM7,980→$3,200 (≈2.49), RM9,980→$3,550 (≈2.81), RM4,300→$1,400 (≈3.07), RM3,220→$1,040 (≈3.10); dua kad MYR berbeza (RM2,990 & RM3,220) kedua-duanya dipaparkan "$1,040" dalam SGD (t16_currency_before.png vs t16_currency_after.png).
3. Kad pertama `/trips` menukar **tarikh "Sail"** antara paparan mata wang: MYR "Sail 14 Nov 2026" → SGD "Sail 28 Nov 2026" untuk trip yang sama (t02_trips.png vs t16_currency_after.png).
4. Sailing **14 Nov 2026** muncul pada kad `/trips` (MYR) dan sebagai kumpulan default wizard, tetapi **tidak wujud langsung** dalam `/cruise-schedule` (17 sailing, tiada padanan "14 Nov") (t02_trips.png, t06_wizard_step1.png vs t17_cruise_schedule.png).
5. Sidebar detail trip: "Start from RM2,990 / person" tetapi butang pakej default & Price Info menunjukkan RM3,220; teks "Price is varies base on current flight price" muncul pada pakej **Cruise Only** yang tiada penerbangan (t03_trip_detail.png).
6. Navbar tidak konsisten antara halaman: homepage (Tour/Cruise/All Trip) vs halaman dalaman (Cruise/Destination/Schedule); label "Cruise" di `/trips` menghala ke `/` (halaman sendiri) manakala di homepage menghala ke cruise.rarecation.com (t01_home.png vs t02_trips.png).
7. Pautan "Tour" pada homepage menghala ke `/` — klik tiada kesan navigasi (t01_home.png).
8. Dropdown Destination mengandungi banyak opsyen tanpa inventori (Sarajevo, Zurich, Interlaken, Jeddah, dll. → 0 hasil) — dead-end kepada pengguna (t02_trips.png, t15c_filter_sarajevo.png).
9. Nav `/booking-terms` tiada pemilih Currency, berbeza dengan halaman awam lain (t20_booking_terms.png vs t02_trips.png).
10. Avatar menu pengguna papar "?" pada `/traveller/billing` tetapi "GA" pada halaman portal lain (t19_billing.png vs t13_bookings.png).
11. Typo berulang pada copy UI: "Price is varies base on current flight price" (t03), "Gratitude fee" (t03 — sepatutnya Gratuities), "Pay at your way" (t12), "Rarecattion Travel" pada halaman maintenance cruise (t21).
12. Deposit (5%) RM322 dipaparkan jelas tetapi butang tindakan hanya menawarkan "**Pay Now — RM 6,440.00**" (jumlah penuh); tiada pilihan "bayar deposit sahaja" yang eksplisit — pengguna perlu tahu boleh edit amaun secara manual (t12_payment_step3.png).

## 4. Jurang e-commerce (diperhati, dengan bukti)

1. **Homepage tiada produk**: seksyen "Most Popular Tours" menunjukkan empty state "No featured tours yet" — landing page tidak mempamerkan mana-mana produk jualan (t01_home.png).
2. **Statistik homepage misleading**: "300+ Tours / 40+ Countries" sedangkan katalog sebenar hanya 17 trips (t01_home.png vs t02_trips.png).
3. **Tiada T&C sebenar**: `/booking-terms` hanyalah placeholder "currently being updated" pada laman yang menerima pembayaran online (t20_booking_terms.png).
4. **Cruise vertical down**: cruise.rarecation.com papar halaman maintenance 503; pautan "Cruise" homepage menghala terus ke sana (t01_home.png, t21_cruise_home.png).
5. **Maklumat penumpang tidak dikumpul sebelum pembayaran**: wizard hanya mengumpul bilangan pax + maklumat billing contact; tiada medan nama/DOB/pasport per guest dalam Step 1–3 (t09, t10, t12).
6. **Harga SGD tidak dapat diterbitkan daripada harga MYR** pada kadar tukar tunggal yang konsisten (nisbah 2.49–3.10 antara kad) — risiko kepercayaan harga & pertikaian bayaran (t16 sebelum/selepas).
7. **Sailing 14 Nov 2026 hilang daripada `/cruise-schedule`** walaupun dijual pada `/trips` dan menjadi default wizard — inventori tidak konsisten antara halaman (t17 vs t02/t06).
8. **Penapis Item group kosong** — hanya "All groups", tiada pilihan lain (t02_trips.png).
9. **Opsyen destinasi tanpa inventori** dalam dropdown penapis — pengguna dibawa ke "0 trips found" (t15c_filter_sarajevo.png).

## 5. Titik Blocked + Sebab

1. **cruise.rarecation.com (keseluruhan vertical cruise)** — halaman maintenance "We'll be right back" + konsol 503 SERVICE UNAVAILABLE; audit kandungan cruise vertical tidak dapat diteruskan (t21_cruise_home.png).
2. **Wizard Step 4 (Confirm) & pelaksanaan pembayaran** — dihentikan secara sengaja mengikut peraturan keselamatan data (JANGAN submit booking/pembayaran); bukan kegagalan sistem (t12_payment_step3.png).
3. **`/traveller/billing` dan `/traveller/booking_addons` (audit penuh)** — tidak dapat diteruskan kerana akaun test tiada booking: billing memaparkan "Booking reference missing.", booking_addons redirect ke `/traveller/bookings` (t19_billing.png, t19_booking_addons.png).
4. **Login tanpa password (magic link) & Google Sign-In** — tidak diuji (di luar pelan; akaun kata laluan digunakan).

## 6. Console Errors (dikumpul sepanjang sesi, baca-sahaja)

| Ralat | Bilangan | Halaman/langkah | Nota |
|---|---|---|---|
| `Failed to load resource: net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` | 21 | Halaman detail trip (t03) dan semua halaman wizard `/booknow` (t06–t11) | Resource cross-origin disekat oleh Chromium; resource tepat tidak dapat dikenal pasti daripada mesej konsol (tiada URL lokasi dilampirkan oleh mesej tersebut). Tidak menghalang fungsi funnel. |
| `Failed to load resource: 503 (SERVICE UNAVAILABLE)` dari `https://cruise.rarecation.com/` | 1 | cruise.rarecation.com (t21) | Konsisten dengan halaman maintenance. |

Tiada `pageerror` (uncaught JS exception) sepanjang sesi.

---

## 7. Persediaan Persekitaran (transparansi)

- Playwright 1.64.1 + Chromium headless, profil persist `gui-audit-workspace/browser-profile` (cookies login kekal antara skrip). Viewport default 1440×900; ujian responsive 390×844 (dipulihkan selepas skrip).
- Console listener error didaftarkan pada setiap skrip (baca-sahaja).
- Login dilakukan sekali melalui GUI dengan akaun test yang dibenarkan; tiada injection cookies/session.
- Semua tindakan wizard menggunakan klik/fill GUI sebenar; navigation antara halaman melalui pautan sebenar (kecuali `/traveller/billing` & `/traveller/booking_addons` yang dilawat terus kerana tiada pautan nav wujud — kedua-duanya disenaraikan dalam pelan ujian).
- Data dummy audit dimasukkan pada Step 2 (alamat KL); tiada fail dimuat naik; tiada profil lain diubah; tiada dokumen dicipta.

**Lampiran:** snapshot DOM (ariaSnapshot) setiap keadaan disimpan di `/home/frappe/gui-audit-workspace/scripts/snapshots/*.txt` (bacaan silang dengan setiap screenshot).
