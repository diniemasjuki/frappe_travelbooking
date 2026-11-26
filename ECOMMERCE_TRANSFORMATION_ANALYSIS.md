# Analisis Transformasi E-Commerce travel_booking

| Meta | |
|---|---|
| **Tarikh** | 2026-11-03 |
| **Status** | DRAFT — untuk semakan |
| **Skop** | Analisis seni bina, model produk & data, aliran jualan, portal, pemetaan ERPNext, jurang dan roadmap. **Analisis sahaja — tiada implementasi kod.** |
| **Sumber bukti** | Eksplorasi kod `travel_booking` (Nov 2026); audit GUI black-box 28 keadaan merentas trip.rarecation.com (Playwright headless, verifikasi silang screenshot + ariaSnapshot DOM; laporan penuh: `gui-test-screenshots/AUDIT_REPORT.md`); kedudukan arsitektur diluluskan pemilik produk. |

## Senarai Kandungan

1. Executive Summary
2. Seni Bina Dicadangkan (Task I — Scalability)
3. Model Produk (Task A)
4. Model Data (Task B)
5. Aliran Jualan (Task C — end-to-end; Task D — Cart; Task E — Booking Engine; Task F — Inventori)
6. Customer Journey & Portal (Task G)
7. Pemetaan ERPNext (Task H)
8. Gap Analysis: dari Booking Management ke Sales Platform (Task J)
9. Roadmap Pelaksanaan (Task J)
10. Final Recommendation
Lampiran A — Kedudukan arsitektur diluluskan pemilik produk

**Glosari istilah cadangan** (digunakan konsisten merentas dokumen): **Cart** / **Cart Item** (DocType baharu — cart persistent merentas kategori), **Checkout Orchestrator** (generalisasi `confirm_booking`; satu-satunya pintu ke Sales Order), **Product Type Strategy** (satu class Python per `product_type`), **Reservation Hold** (slot sementara ber-TTL semasa checkout), **Catalog Query Layer** (lapisan baca katalog tunggal merentas kategori), **Saved Quote** (sebut harga berasaskan Quotation ERPNext, boleh ditukar menjadi booking), **lapisan Commerce** (keseluruhan paket Cart + Checkout Orchestrator + Promo Engine + Catalog Query Layer di atas backbone ERPNext), **strangler fig** (corak migrasi berperingkat: sistem baharu membungkus sistem lama sedikit demi sedikit sehingga yang lama boleh dibersarakan tanpa henti sistem), **parity harness** (set ujian automatik yang membandingkan keluaran laluan lama vs laluan baharu baris demi baris sebelum yang lama dibersarakan). Rujukan badan dokumen kepada "kedudukan diluluskan #N" merujuk senarai kelulusan pemilik produk yang dilampirkan dalam **Lampiran A** — penomborannya berbeza daripada senarai keputusan §1.

Semua DocType yang dilabel **(baharu)** belum wujud dan perlu dicipta; semua DocType lain disahkan wujud dalam `travel_booking/travel_booking/module_travel_booking/doctype/` (68 DocType) atau `travel_booking/resources_management/doctype/` (3 DocType crew), atau ialah dokumen standard ERPNext.

---

## 1. Executive Summary

`travel_booking` hari ini ialah sistem pengurusan tempahan yang **berfungsi hujung-ke-hujung**: funnel cruise/tour — katalog, halaman detail dengan harga live, wizard 4 langkah, OTP, Sales Order (SO), pembayaran Stripe/manual, portal traveller — disahkan dua lapis: audit GUI black-box 28 keadaan (Nov 2026) menyaksikan funnel berjalan sehingga Step 3 pembayaran sahaja (Step 4 Confirm & pelaksanaan pembayaran dihentikan sengaja — tiada dokumen dicipta), manakala penciptaan SO, pembayaran dan rantai doc events disahkan melalui eksplorasi kod. Tetapi ia ialah *single-purpose funnel*: satu trip, satu SO, tiada cart, merchandise dan addon berjalan melalui endpoint berasingan, promo hanya berkesan pada booking utama, dan quote tidak wujud (terus ke SO). Audit turut menemui gejala seni bina bercabang: harga kad SGD tidak terbit daripada satu sumber kebenaran (nisbah MYR 2.49–3.10 antara kad), sailing 14 Nov 2026 dijual pada `/trips` tetapi hilang dari `/cruise-schedule`, homepage tanpa produk. Dokumen ini menghujahkan transformasi daripada booking management kepada **sales platform penuh — tanpa memecah backbone transaksi ERPNext yang terbukti**.

**Keputusan utama** (perincian di seksyen 2–10):

1. **Kekal ERPNext SO/SI/PE sebagai backbone transaksi.** SO kekal *source of truth* harga dan sentiasa GROSS; voucher/referral/cashback diserap sebagai Payment Entry (PE) deductions ke akaun Marketing Expenses. Lapisan Commerce baharu dibina **dalam** `travel_booking`, bukan app berasingan, kerana rantai doc events `on_sales_order_change` tidak boleh diputus.
2. **Checkout Orchestrator menjadi satu-satunya pintu ke SO** — generalisasi `confirm_booking` dengan Product Type Strategy per `product_type` (validate → price → hold → baris SO → fulfilment). Semua saluran (web, portal, B2B, API masa depan) melaluinya.
3. **Cruise/departure kekal master domain** (Trip → Trip Group Date → Trip Cruise Schedule), bukan Item/Item Variant; merchandise sahaja Item ERPNext (+ Item Variant untuk size/colour). webshop **tidak diadopsi**.
4. **Cart (DocType baharu)** — persistent, merentas kategori (`product_type`: trip_package / addon_package / merchandise / flight / activity), currency-pinned dari geo axis; menggantikan `sessionStorage bnw_cart` secara berperingkat (strangler fig — lihat glosari).
5. **Promo dinaik ke peringkat cart**: voucher merentas kategori; price rule kekal per-produk best-only; susunan stacking ditakrifkan eksplisit; SO kekal GROSS.
6. **Overbooking gate `FOR UPDATE` dikemas kini sekali sahaja** untuk memasukkan Reservation Hold (`held_pax` pada Trip Group Date, dalam transaksi sama dengan gate) — hold bukan sistem selari.
7. **Inventori mengikut semula jadi produk**: merchandise = stok ERPNext sedia; cruise = cabin allotment + registry Cruise Cabin sedia + hold; flight = seat counters; activity = Activity Schedule slot (Fasa 2).
8. **Portal bertambah** My Orders dan Saved Quote (Fasa 1) serta Wishlist, direktori My Travellers dan hub Documents (Fasa 2).

**Roadmap.** Fasa 1 (bulan 1–3, asas jualan): Universal Cart, Checkout Orchestrator, promo cart-level, guest merchandise checkout, Saved Quote, Reservation Hold, portal My Orders; wizard lama kekal live sehingga lulus parity test. Fasa 2 (bulan 4–7, kedalaman produk & operasi): slot aktiviti, hotel master, flight sebagai produk jualan, search/facets melalui Catalog Query Layer, refund automation, cukai/penghantaran merchandise, portal B2B self-service, Wishlist. Fasa 3 (bulan 8–12+, skala & ekosistem): marketplace multi-supplier, API layer B2B/OTA, corporate booking, loyalty/reviews.

**Risiko terbesar ialah disiplin, bukan reka bentuk.** Tiga risiko keterukan tinggi: (i) dua laluan checkout hidup serentak semasa migrasi `booknow.js` (5,534 baris) boleh divergen harga/gate — dimitigasi dengan strangler fig dan parity harness; (ii) Reservation Hold yang tidak dikira dalam `SUM(booked_pax)` menjadikan gate `FOR UPDATE` boleh lulus walaupun slot sudah di-hold — dimitigasi dengan medan `held_pax` dalam transaksi sama; (iii) pengagihan voucher cart-level merentas beberapa SO pada cart berbilang trip (peraturan SO-per-cart §5.3) mesti memecah `received + deductions = allocated` — dimitigasi dengan modul allocasi tunggal dan larangan keras menulis diskaun pada baris SO. Setiap cadangan dalam dokumen ini menyatakan kesannya terhadap keempat-empat invariant sistem sedia ada.

---

## 2. Seni Bina Dicadangkan (Task I — Scalability)

### 2.1 Prinsip reka bentuk

Cadangan ini menghujahkan satu perkara terpenting dahulu: **transaksi kekal di ERPNext, logik commerce baharu duduk dalam travel_booking**. Sales Order (SO) kekal *source of truth* harga; Sales Invoice (auto) dan Payment Entry (PE) kekal sebagai hujung wang. Apa yang kita bina ialah **lapisan Commerce** — Cart, Checkout Orchestrator, Promo Engine peringkat cart, Catalog Query Layer — yang duduk *di atas* masters domain sedia ada dan *di hadapan* backbone ERPNext. Ini bukan rewrite; ia ialah generalisasi corak yang telah terbukti dalam `api/booking_engine.py` (funnel booking cruise/tour wujud dan berfungsi, disahkan audit GUI Nov 2026: wizard 4 langkah — Step 1 Rooms & Passengers, Step 2 Billing, Step 3 Payment, Step 4 Confirm — berjalan penuh sehingga Step 3 sahaja; Step 4 & pelaksanaan pembayaran dihentikan sengaja mengikut peraturan keselamatan data audit, tiada dokumen dicipta).

Empat invariant wajib dijaga pada setiap lapisan (rujuk seksyen 5 di mana setiap satu disentuh):
1. **SO-GROSS**: SO sentiasa gross; voucher/referral/cashback diserap sebagai PE deductions ke akaun Marketing Expenses.
2. **Currency axis**: `travel_settings.currency_accounts` (Travel Currency Account) — conversion_rate 1.0, multi-company, tiada FX conversion.
3. **Overbooking gate**: `SELECT ... FOR UPDATE` pada Trip Group Date (TGD) + SUM(booked_pax) vs max_participants.
4. **Rantai doc events**: `hooks.py:87-119` — on_update/on_update_after_submit/on_cancel/on_trash Sales Order → `on_sales_order_change` → `_recompute_booking_status`.

### 2.2 Diagram seni bina berlapis

```
┌────────────────────────── LAPISAN PRESENTATION ─────────────────────────────┐
│  Laman awam www/ (Jinja + base_travel.html)   Portal /traveller/*    Desk   │
│  ├─ /trips, /cruises, /tours (katalog)         ├─ bookings,         ├─ mo-  │
│  ├─ /cruise-schedule (timeline)                │  booking?ref=      │  dule │
│  ├─ /<trip-route> (detail + widget pakej)      │  billing, trans-   │  _ad- │
│  ├─ /booknow (wizard 4 langkah — kekal)        │  actions, profile  │  min_ │
│  ├─ /cart, /checkout (baharu — Fasa 1)         ├─ travellers (pas-  │  por- │
│  └─ /booking-terms, /guest_passport            │  sport OCR MRZ)    │  tal │
│                                                └─ onbehalf-* mirror │ page- │
│  Semua akses melalui API whitelisted (type-annotated,                          │
│  use_json_request_body) — tiada akses DB terus dari JS                          │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
┌─────────────────────── LAPISAN COMMERCE (BAHARU) ────────────────────────────┐
│  api/cart.py (baharu)              — Cart service: CRUD Cart/Cart Item,       │
│                                       currency-pinned, expiry, merge login    │
│  api/checkout_orchestrator.py      — generalisasi confirm_booking; urus       │
│    (baharu)                          validate→price→hold→SO→pay per item      │
│  api/promo_engine.py (baharu)      — promo cart-level merentas kategori       │
│  api/product_strategies/ (baharu)  — Product Type Strategy per kategori:      │
│    ├─ trip_package.py  ├─ addon_package.py  ├─ merchandise.py                │
│    ├─ flight.py        └─ activity.py                                       │
│  api/catalog_query.py (baharu)     — Catalog Query Layer penyatu 5 kategori   │
│  DocType (baharu): Cart, Cart Item, Reservation Hold                         │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │  baca/tulis masters domain sahaja —
                                │  tiada pintasan terus ke ERPNext dari UI
┌──────────────────────── DOMAIN MASTERS (sedia ada + 2 baharu) ───────────────┐
│  Trip → Trip Group Date (departure) → Trip Cruise Schedule (sailing)         │
│           └─ child cabin_rates (Trip Package Price: allotment/occupancy)     │
│  Cruise Cabin (registry stateroom)      Trip Price Category (master kategori)│
│  Trip Package (unit jualan; package_type 5 jenis)                           │
│    └─ Trip Package Price (per kategori × currency) + Trip Package Component  │
│  Trip Addon → Trip Addon Package (AP.YY.MM.###; currency_rates; scoping;     │
│    validity; cutoff; max_qty)                                               │
│  Item + Item Price (merchandise; Item Group Merchandise; is_public_)         │
│  Flight cluster (fulfilment): Flight (per PNR, max_seat), Flight Airline,    │
│    Flight Airport, Flight Schedule, Flight Request                          │
│  Trip Organizer (penganjur/cruise line; is_a_cruise_line)                    │
│  Travel B2B Partner (+ users access_level; package_discounts net-rate)       │
│  (baharu) Activity Schedule  │  (baharu) Hotel Master                       │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
┌────────────────────────── ERPNEXT BACKBONE (KEKAL) ──────────────────────────┐
│  Customer/Contact/Dynamic Link │ Sales Order (custom_booking, custom fields) │
│  Sales Invoice (auto) + Sales Return (credit note)                          │
│  Payment Request (Stripe) + Payment Entry (manual + deductions + settlement) │
│  Item, Item Price, Stock Reservation Entry (reserve_so_stock),               │
│  Delivery Note (create_delivery_notes_for_trip per TGD)                      │
│  Company, Account, Bank Account, Price List, Warehouse, Bin                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Tanggungjawab setiap lapisan

**Lapisan Presentation.** Laman awam (`travel_booking/www/`) kekal Jinja + `base_travel.html` — kita tidak berpindah ke web.html Frappe mahupun Builder. Yang bertambah: halaman `/cart` dan `/checkout` (baharu, Fasa 1) yang berkomunikasi dengan lapisan Commerce melalui API whitelisted sahaja, mengikut konvensyen sedia ada (type-annotated, `use_json_request_body`, cache-busting `?v=`). Wizard `/booknow` 4 langkah **kekal** untuk booking trip tulen sepanjang tempoh migrasi Fasa 1 — ia telah berfungsi penuh; Cart menjadi laluan baharu untuk mixed-cart (cth. trip + merchandise + addon). Selepas laluan cart lulus parity test, wizard dibelit oleh Cart API: UI `/booknow` kekal sebagai pintu funnel trip, tetapi state `sessionStorage` dibuang (lihat §8.2, §9.2). Portal `/traveller/*` bertambah "My Orders" (merchandise) dan "Saved Quote" (Fasa 1); Wishlist menyusul Fasa 2. Desk admin (`module_admin_portal/page/`) tidak berubah strukturnya; ia hanya membaca DocType baharu (Cart, Reservation Hold) sebagai view tambahan.

**Lapisan Commerce (baharu).** Ini jantung cadangan. Empat komponen:

- **`api/cart.py` (baharu) + DocType Cart/Cart Item (baharu)**: cart persistent (bukan sessionStorage), cross-category. Cart Item membawa `product_type` discriminator (trip_package/addon_package/merchandise/flight/activity) + params JSON (tarikh, pax, kabin, saiz merchandise). Cart di-*pin* pada satu currency dari geo axis semasa penciptaan — menukar currency = kosongkan cart (elak FX conversion yang memang tidak wujud dalam sistem). Peraturan *merge login*: apabila guest log masuk, cart guest digabung dengan cart user sedia — baris bertindan (`product_type` + reference + `params` sama) digabung kuantitinya; jika currency kedua-duanya berbeza, cart user menang dan cart guest ditanda `Merged` dengan barisnya dilupuskan serta notifikasi pada pengguna.
- **`api/checkout_orchestrator.py` (baharu)**: generalisasi `confirm_booking`. Corak sedia ada — parsing → T&C gate → OTP gate → `_create_customer` → pricing → kapasiti → SO → Booking → portal user → bayaran — dikekalkan sebagai *urutan peringkat*, tetapi peringkat "validate/price/reserve/baris SO" didelegasikan kepada **Product Type Strategy** per item. Booking trip tetap menghasilkan keluaran yang sama seperti hari ini (Booking + Booking Reservation per pax); merchandise menghasilkan SO item stok + reserve; addon menghasilkan Booking Addon. Bypass OTP untuk staff/B2B diteruskan.
- **`api/promo_engine.py` (baharu)**: Voucher diperluas ke cart-level merentas kategori (diskaun atas subtotal item yang match scope). Price rule kekal per-produk best-only, dikira dahulu pada harga NET; voucher cart dikira selepasnya atas subtotal promo — peraturan stacking ditakrifkan eksplisit: **price rule (per-item, best-only) → voucher (cart, satu sahaja) → referral (satu, B2B dilarang)**. Deduksi kekal masuk sebagai PE deductions; SO kekal GROSS.
- **`api/catalog_query.py` (baharu)**: Catalog Query Layer penyatu — satu antara muka query untuk 5 kategori (pakej trip, addon, merchandise, flight, activity) dengan filter/facet/sort/currency yang konsisten. Hari ini katalog trip (`trip_catalog.py`) dan merchandise (`api/merchandise.py` → `get_public_merchandise`) ialah dua laluan berasingan; audit GUI menunjukkan akibatnya: sailing 14 Nov 2026 muncul pada `/trips` tetapi hilang dari `/cruise-schedule` — dua query, dua kebenaran. Catalog Query Layer memusatkan penapisan status/ketersediaan supaya semua halaman membaca sumber sama.

**Lapisan Domain Masters.** Semuanya sedia ada kecuali dua tambahan bertanda (baharu): **Activity Schedule** (slot tarikh + qty caps untuk aktiviti, menyambung tradisi `Flight.max_seat`) dan **Hotel Master** (Fasa 2, untuk komponen penginapan ground). Cruise/departure **kekal master domain** — Trip → TGD → Trip Cruise Schedule — bukan Item/Item Variant; hanya merchandise guna Item ERPNext. Trip Package kekal BOM custom (Trip Package Component), bukan ERPNext Product Bundle.

**Lapisan ERPNext Backbone.** Tidak berubah. SO dibina secara dinamik oleh Orchestrator, SI auto via `_maybe_auto_invoice_so`, PE dengan deductions, Stock Reservation Entry, Delivery Note. Semua integrasi programatik sedia (seksyen 7) diteruskan tanpa tambahan permukaan.

### 2.4 Aliran rujukan end-to-end (booking cruise + merchandise dalam satu cart)

```
Browse        → Catalog Query Layer → kad trip / merchandise, harga ikut geo axis
               (geo_currency: param > cookie > CF-IPCountry > default)
Add to cart   → POST api/cart.py → Cart Item (product_type, params, currency-pinned)
Checkout      → /checkout → Checkout Orchestrator:
  1. VALIDATE → Product Type Strategy per item:
                 trip_package: kapasiti kategori + cabin allotment (Trip Package Price)
                 merchandise: Bin/actual_qty stok
  2. PRICE    → re-price server-side (jangan percaya harga klien):
                 _get_pricing_map → price rule (best-only, NET pada SO)
                 → promo engine cart-level (voucher/PE deduction)
  3. HOLD     → Reservation Hold (baharu; TTL dari Travel Settings
                 cart_hold_ttl_minutes, default 15 minit) per item inventori
  4. GATES    → OTP gate (Redis booking_email_verified_<email>) + T&C
               → _create_customer (Customer+Contact+DynamicLink)
  5. OVERBOOKING GATE (trip sahaja):
                 SELECT ... FOR UPDATE pada TGD + SUM(booked_pax)
                 vs max_participants  ← invariant #3 DIKEKALI
  6. SO       → satu SO (Administrator) mengandungi baris trip (TRAVEL-PKG
                 per pax + custom_room_category dll.) + baris merchandise
                 (item stok + reserve_so_stock)      ← SO-GROSS (#1) DIKEKALI
  7. BAYARAN  → Payment Request Stripe /checkout?pr= atau draft PE manual
                 → voucher diserap sebagai PE deductions selepas settlement
                 (/_settle_order_discount_residue)   ← invariant #1 DIKEKALI
  8. EVENTS   → SO on_update_after_submit → on_sales_order_change →
                 _recompute_booking_status → _activate_booking →
                 Booking Reservation per pax + SI auto + Delivery Note pukal
                                                  ← invariant #4 DIKEKALI
Fulfilment    → cruise: Cruise Cabin assignment; merchandise: Delivery Note
                 per TGD; flight: Flight Request → Flight (PNR)
Portal        → /traveller/bookings (trip) + My Orders (merch) + Saved Quote
```

Titik kritikal: Cart **tidak pernah** menulis ke TGD/cabin_rates sehingga peringkat hold; dan Reservation Hold hanya *penanda tempoh*, bukan pengurangan `current_participants` — pengurangan sebenar tetap berlaku di dalam overbooking gate FOR UPDATE semasa penciptaan SO, seperti hari ini. Ini memastikan invariant #3 tidak terpesong oleh lapisan baharu.

### 2.5 Task I — Scalability

**(a) Multi cruise operator.** `Trip Organizer` dengan `is_a_cruise_line` (disahkan `trip_organizer.json:64`) **cukup** untuk Fasa 1–2. Ia telah menjadi master penganjur per trip; cabaran sebenar bukan bilangan operator tetapi allotment per operator — dan itu sudah diselesaikan oleh `cabin_rates` (Trip Package Price per Trip Cruise Schedule) + registry Cruise Cabin. Cadangan: kekalkan; tambah field `organizer_code` (baharu) hanya bila integrasi API operator luar datang (Fasa 3), kerana mapping kod luar perlu anchor.

**(b) Multi airline.** Cluster `Flight Airline` / `Flight Airport` / `Flight Schedule` / `Flight` (per PNR) sedia ada dan mencukupi untuk berbilang airline — ia memang direka per-PNR dengan `max_seat`/`seats_occupied`. Tiada perubahan Fasa 1. Jualan flight sebagai produk (bukan fulfilment) menyusul Fasa 2 melalui Product Type Strategy `flight.py` yang membaca cluster sama.

**(c) Multi supplier.** Berpendirian: **kekal Trip Organizer sebagai master penyedia tunggal** untuk Fasa 1–2. Menambah supplier master berasingan sekarang mencipta entiti ketiga yang bertindih dengan Trip Organizer (penganjur) dan Travel B2B Partner (rakan jualan) — dua peranan berbeza yang mudah dirancukkan. Bila Fasa 3 marketplace tiba, naik taraf Trip Organizer dengan `supplier_type` + `is_marketplace_seller` (field baharu) serta perhubungan pembayaran/commission — bukan DocType baharu. Ini mengekalkan satu kebenaran tentang "siapa menyediakan".

**(d) B2C.** Sedia berfungsi (guest checkout trip, OTP email, portal traveller). Cart menambah guest merchandise checkout (Fasa 1) — satu-satunya perubahan: `create_merch_order` yang hari ini perlu login akan dilalui oleh Orchestrator yang mencipta Customer untuk guest seperti `_create_customer` sedia.

**(e) B2B agent.** `Travel B2B Partner` + `travel_b2b_partner_user` (field `user`, `access_level` — disahkan JSON) + `travel_b2b_package_discount` (net-rate) sedia. Fasa 1: B2B terus guna on-behalf flow sedia. Fasa 2/3: portal self-service B2B (browse net-rate via Catalog Query Layer + checkout terus, `additional_discount_percentage` pada SO kekal mekanisme diskaun) dan quota/kredit. Invariant: B2B dilarang voucher/referral — diteruskan di promo engine.

**(f) Corporate booking.** Fasa 3. Cadangan: DocType **Corporate Account (baharu)** sebagai sub-jenis Customer group + `cost_centre` field pada Cart/Booking (baharu) + aliran approval ringkas (Booking state `Awaiting Approval` baharu) + SI terkumpul bulanan. Ini semata-mata lapisan atas Orchestrator; SO/SI tidak berubah.

**(g) API integration.** Fasa 3: endpoint REST whitelisted per resource (search, cart, checkout status) + **API Key (baharu)** per B2B partner (Frappe token auth) + rate limiting + webhook (booking confirmed, payment settled) melalui corak `travel_email_notification` sedia. Kunci: semua endpoint public melalui Orchestrator sahaja — tiada endpoint yang memintas SO-gross atau FOR UPDATE gate.

### 2.6 Ringkasan: apa berubah / apa kekal

| Komponen | Keputusan | Kesan invariant |
|---|---|---|
| SO/SI/PE backbone | **KEKAL** sepenuhnya | Tiada |
| Trip → TGD → Schedule masters | **KEKAL** (bukan Item) | Tiada |
| confirm_booking + wizard /booknow | **KEKAL** sepanjang migrasi Fasa 1; selepas parity lulus, UI `/booknow` kekal di atas Cart API (state `sessionStorage` dibuang) | Backend sama; tiada |
| on_sales_order_change doc events | **KEKAL** (`hooks.py:116-119`) | Rantai kekal utuh |
| Overbooking gate FOR UPDATE | **KEKAL**, dipanggil oleh Orchestrator | Dipelihara di peringkat 5 aliran |
| SO-GROSS + PE deductions | **KEKAL**; promo cart turut masuk sebagai PE deductions | Dipelihara |
| Currency axis (Travel Currency Account) | **KEKAL**; Cart pinned pada satu currency | Dipelihara; tiada FX baharu |
| webshop | **TIDAK diadopsi** (model Quotation-cart bercanggah) | Tiada |
| Lapisan Commerce (cart/orchestrator/promo/catalog) | **BAHARU** Fasa 1 (`api/cart.py` dll.) | Baca sahaja terhadap masters; tulis melalui SO |
| DocType Cart/Cart Item/Reservation Hold | **BAHARU** Fasa 1 | Hold tidak sentuh current_participants |
| Activity Schedule, Hotel Master | **BAHARU** Fasa 2 | Tiada |
| Flight sebagai produk jualan | **BAHARU** Fasa 2 (strategy flight.py) | Output tetap SO |
| Corporate, API/webhook, marketplace | **BAHARU** Fasa 3 | Semua melalui Orchestrator |

**Kesimpulan pendirian:** seni bina ini ialah tambahan satu lapisan, bukan penggantian. Risiko terbesar bukan reka bentuk tetapi disiplin — sebarang laluan baharu yang menulis harga/inventori tanpa melalui Orchestrator akan memusnahkan empat invariant. Sebab itu Catalog Query Layer dan Product Type Strategy dijadikan pintu tunggal wajib sejak Fasa 1, walaupun wizard lama kekal berfungsi selari.

---

## 3. Model Produk (Task A)

### 3.1 Prinsip asas: dua lapisan katalog, bukan satu

Platform ini menjual lima kategori produk (trip package, addon package, merchandise, flight, activity) tetapi TIDAK semua patut dimodelkan sama. Cadangan: kekalkan **dua lapisan** yang telah terbukti dalam kod semasa:

1. **Lapisan master domain travel** (bukan Item ERPNext): Trip → Trip Group Date → Trip Cruise Schedule → Trip Package (+ Trip Package Price) → Trip Addon Package. Ini sumber kebenaran bagi tarikh, allotment kabin, pax-type pricing.
2. **Lapisan Item ERPNext**: hanya merchandise (Item + Item Group, stok via Bin/Stock Reservation Entry) dan *item service bayangan* untuk baris Sales Order — `TRAVEL-PKG` yang dikongsi untuk semua jenis pax (disahkan `travel_booking/api/booking_engine.py:730`, dicipta dalam `travel_booking/install.py:79-83`) serta Item per Trip Addon Package dan Item merchandise.

**Product Master Structure per kategori:**

| Kategori | Master domain | Item SO | Sumber harga | Inventori |
|---|---|---|---|---|
| Trip Package | Trip Package (TP.YY.MM.##) → package_pricing (child Trip Package Price) | `TRAVEL-PKG` (satu baris per pax) | Trip Package Price per Trip Price Category × currency | TGD `max_participants/current_participants` + cabin allotment pada Trip Package Price |
| Addon Package | Trip Addon Package (AP) → currency_rates | Item per addon | Trip Addon Package Rate per currency | `max_total_qty/current_qty_sold` |
| Merchandise | ERPNext Item sahaja | Item itu sendiri | Item Price per price list | Bin + Stock Reservation Entry |
| Flight (Fasa 2, jualan) | Flight (field `pnr`) | item service (baharu) | rate seat FIT/GIT ditetapkan admin — re-price server-side semasa checkout (snapshot Cart Item indicative sahaja) | `max_seat/seats_occupied` |
| Activity (Fasa 2, slot) | Trip Addon (addon_type Activity) + Activity Schedule *(baharu)* | Item per addon | Trip Addon Package Rate | Activity Schedule slot capacity |

**Item Category Structure:** Item Group "Merchandise" (sedia ada, dengan custom `is_public_merchandise` pada Item) dipecah kepada subtree *(baharu)*: `Merchandise/Apparel`, `Merchandise/Souvenir`, `Merchandise/Travel Kit` — ini menyokong facet katalog (jurang audit: tiada search/faceting merchandise). Item service (`TRAVEL-PKG`, addon) kekal di Item Group Services; ia *implementation detail* SO, bukan objek katalog.

**Bundle Structure:** dua peringkat. (i) **Bundle produk** = Trip Package Component (child table sedia ada: `component_type` Activity/Excursion/Transfer/Merchandise/Miscellaneous, `inclusion_mode` Included/Optional/Post-booking Addon, `merchandise_item`, `item_code_override`) — BOM custom ini kekal. (ii) **Bundle cart** *(baharu)* = gabungan Cart Item pelbagai kategori dalam satu Cart; ia TIDAK menjadi Item atau Product Bundle ERPNext, hanya agregat baris semasa checkout.

**Package Structure:** Trip Package kekal unit jualan dengan diskriminator `package_type` (Fly Package / Ground Only / Cruise + Flight / Cruise Only / Customed) dan kunci harga `price_adult/price_adult_single/price_upperberth/price_children/price_toddler/price_infant` per Trip Price Category × currency (disahkan `trip_package_price/trip_package_price.json`, istable). Cruise = model SLOT, non-cruise = model AGE — struktur ini menyerap kedua-dua semantik tanpa variant.

### 3.2 Lima soalan keputusan

**(a) Cruise patut jadi Item (ERPNext)? — KEPUTUSAN: TIDAK**

| Pro jadikan Item | Kontra |
|---|---|
| Seragam dengan webshop/Item Price | Stok Item = bilangan unit; cruise = allotment per kabin per sailing per departure — tidak muat |
| Search standard | Harga per pax-type (6 kunci) + kategori kabin tidak termuat dalam Item Price |
| Tax template standard | Overbooking gate `SELECT ... FOR UPDATE` pada TGD (booking_engine) terpaksa dilupus |

Cruise kekal master domain Trip → TGD → Trip Cruise Schedule; baris SO terus guna `TRAVEL-PKG`. Ini sejajar kedudukan diluluskan #2. Item ERPNext sebenar akan berlari berkembar dengan `cabin_allotment/cabin_available` pada Trip Package Price — dua sumber kebenaran inventori.

**(b) Cruise Schedule patut jadi Variant? — KEPUTUSAN: TIDAK.** Trip Cruise Schedule (autoname `.ship_code.YY.#`, child `cabin_rates`) adalah *sailing* dengan kitaran hidup, status dan registry Cruise Cabin tersendiri. Variant ERPNext hanyalah kombinasi attribute nilai pada Item induk — menjadikan schedule variant bermakna setiap sailing baru mewujudkan puluhan varian (satu per kategori kabin) yang mesti disegerakkan dengan `cabin_rates`, dan status "sailing ditutup" tiada padanan semantik varian. Kedudukan diluluskan #2 mengekalkan schedule sebagai master.

**(c) Departure Date patut jadi Variant? — KEPUTUSAN: TIDAK — ini anti-pattern "variant explosion".**

| Pro | Kontra |
|---|---|
| Nampak "satu produk, banyak tarikh" | **Tiada semantik tarikh**: varian Item tidak mempunyai konsep `departure_date` berbanding hari ini; early-bird Travel Price Rule (`min_days_before_departure`) dan sales cutoff addon dikira relatif tarikh — mustahil pada varian statik |
| Harga varian via Item Price | **Inventori tidak serasi**: `max_participants` pada TGD dengan overbooking gate `FOR UPDATE` tidak boleh dipetakan ke stok varian; penukaran tarikh (Booking Amendment) akan "tukar varian" padahal realitinya cipta SO baharu + credit note |
| | **Pertumbuhan tak terkawal**: 1 trip × 30 departure × 5 kategori kabin = 150 varian per trip setahun; 17 trip hari ini ≈ 2,550 varian, semua perlu Item Price per currency (6 pax-key tidak muat lagi) |
| | **UX carian tarikh rosak**: pengguna mencari *departure dalam Julai 2027* — query varian tidak menyokong range date picker; TGD dengan `departure_date/return_date` (disahkan `trip_group_date.json`) membolehkan query terus |

**(d) Activity patut jadi Add-On? — KEPUTUSAN: YA.** Activity sudah termodel dua saluran: Trip Addon → Trip Addon Package (addon_type Activity, scoped via child `trip_scoping`, `max_qty_per_booking/max_total_qty`) dan Trip Package Component (`component_type` Activity, `inclusion_mode`). Fasa 2 hanya perlu menambah **Activity Schedule** *(baharu)* untuk slot tarikh/kuantiti, di-link ke Trip Addon Package. Ini mengekalkan satu enjin harga/checkout (Product Type Strategy `addon_package`) berbanding mencipta kategori produk keempat yang menyalahi enjin addon sedia ada.

**(e) Travel Package patut jadi Product Bundle (ERPNext)? — KEPUTUSAN: TIDAK.** Product Bundle ERPNext meletakkan sub-item dalam baris SO dengan kuantiti tetap; ia tidak mempunyai (i) availability bergantung tarikh (kabin pada sailing tertentu), (ii) harga per pax-type × currency × Trip Price Category, (iii) `inclusion_mode` Optional/Post-booking. Trip Package + Trip Package Component BOM custom sudah mengekalkan perkara ini, dan baris SO `TRAVEL-PKG` per pax adalah asas kiraan `booked_pax` (booking_engine.py:1219) — Product Bundle akan merosakkan invariant itu.

### 3.3 Item Variant: merchandise sahaja, bila wajar

Item Variant ERPNext wajar untuk merchandise apabila: (i) produk mempunyai attribute pilihan pembeli yang tidak menjejaskan ketersediaan inti (size S/M/L, colour); (ii) setiap kombinasi mempunyai SKU stok sendiri; (iii) bilangan kombinasi kecil (<~30) dan stabil. **Tidak wajar** apabila: variasi adalah pilihan masa (tarikh departure, kabin) — itu inventori berjadual, bukan varian; variasi pax-type (adult/child) — itu struktur harga pada baris yang sama, seperti `price_adult/price_children` pada Trip Package Price; atau variasi "Customed" package — itu Trip Package berasingan. Migrasi varian merchandise sedia ada perlu dibuat melalui Item Variant sedia ERPNext tanpa kod custom tambahan.

### 3.4 Catalog Query Layer

*(baharu — modul Python sahaja, bukan DocType)* Lapisan penyatu READ-ONLY yang memberi antara muka tunggal kepada web/Jinja merentas kategori:

- **Fungsi**: `search_products(query, filters, currency)` → hasil normalised `{product_type, title, image, url, price_from, availability_hint}`; `get_facets()` → aggregat; `get_price_from(product_type, reference, currency)` → delegasi harga.
- **Sumber data**: trip & TGD (katalog trip sedia, `travel_booking/www/` + utils `trip_catalog`), Trip Addon Package (via scoping), Item merchandise (dengan `is_public_merchandise`, menggantikan katalog flat limit-100); Fasa 2 menambah Activity Schedule, Flight `sellable`, Hotel Master.
- **Facet asas**: destination (Trip Destination Point), product_type, item_group (merchandise), julat tarikh (TGD `departure_date`), bucket harga, duration (`total_days`).
- **Ranking asas**: `featured_trip` dahulu, kemudian published terbaru, kemudian harga menaik; teks match pada `trip_name/package_title/item_name`.
- **Kesan invariant**: sifar — lapisan ini tidak menulis apa-apa; harga masih melalui `_get_pricing_map`/Item Price dan checkout kekal re-price server-side. Ini juga menyelesaikan isu audit SGD/MYR tak konsisten kerana penukaran mata wang dipusatkan pada satu titik. Nota pemasaan: punca isu ialah data harga per-currency (bukan kod), jadi pembetulannya ialah kerja data yang dimulakan serta-merta pada minggu pertama (lihat §10.2) — tidak menunggu Fasa 2; Catalog Query Layer kemudian memusatkan resolusi currency supaya isu tidak berulang.

---

## 4. Model Data (Task B)

### 4.1 DocType BAHARU dicadangkan

Semua dalam module sedia ada **Module Travel Booking** (mengelak module baharu sehingga skala menuntut), kecuali dinyatakan. Penamaan ikut gaya sedia ada (TP.YY.MM.##, AP.YY.MM.###, PR.YY.MM.##).

| DocType *(baharu)* | Autoname | Field utama (lakaran) |
|---|---|---|
| **Cart** | `CART.{YY}.{MM}.{#####}` | `status` (Active/Merged/Converted/Expired), `session_key` (guest) atau `user` (Link User), `email`, `currency` (Link Currency — pinned dari geo axis), `items` (Table Cart Item), `subtotal_snapshot` (Currency), `expires_on`, `converted_sales_order` (Link), `converted_booking` (Link), `source` (Web/Portal/B2B) |
| **Cart Item** (child, istable) | — | `product_type` (Select: Trip Package/Addon Package/Merchandise/Flight/Activity), `trip_package`, `trip_addon_package`, `item`, `activity_schedule_slot`, `flight` (Link mengikut discriminator), `params` (JSON: TGD, pax breakdown, kabin, room_category), `qty`, `currency`, `unit_price_snapshot`, `line_total_snapshot` |
| **Reservation Hold** | `HOLD.{YY}.{MM}.{#####}` | `hold_type` (Cabin Allotment/Stock/Seat/Activity Slot), `reference_doctype/reference_name` (Dynamic Link), `qty`, `cart` (Link Cart), `expires_on`, `status` (Held/Consumed/Released/Expired), `released_on` |
| **Activity Schedule** | `ACT.{YY}.##` | `activity_name`, `trip_addon_package` (Link), `location`, `status`, `slots` (Table: `slot_date`, `start_time`, `end_time`, `capacity`, `booked_qty`, `status`) |
| **Saved Quote** | `SQ.YY.MM.###` | `email`/`customer`, `currency`, `items` (Table: product_type, reference, params, qty, unit_price snapshot), `total`, `valid_until`, `status` (Draft/Sent/Accepted/Expired/Converted), `quotation` (Link Quotation — dokumen komersial ERPNext), `converted_cart` |
| **Wishlist** | `WISH.{#####}` (satu per user) | `user`/`session_key`, `items` (Table child **Wishlist Item** *(baharu)*: `product_type`, `reference_doctype/reference_name`, `note`, `added_on`) |
| **Hotel Master** (Fasa 2) | `HOTEL.{YY}.##` | `hotel_name`, `city`, `country`, `star_rating`, `trip_organizer` (Link — supplier), `room_types` (Table: `room_type_name`, `capacity`, `max_capacity`, `price_category` link Trip Price Category) |

Scheduler harian sedia (hooks.py `mark_abandoned_pending_bookings` dll.) diperluaskan dengan pembersih: expire Cart & Reservation Hold lewat TTL.

### 4.2 DocType SEDIA ADA yang perlu DIUBAH

| DocType | Perubahan | Justifikasi |
|---|---|---|
| **Booking** | + `cart_source` (Link Cart), + `order_type` (Select: Trip Booking/Mixed) | Traceability funnel. Peraturan penciptaan: Booking hanya dicipta untuk cart yang mengandungi baris trip; cart merchandise tulen TIDAK mencipta Booking (SO dengan `custom_cart` sahaja — inilah asas My Orders §6.1, konsisten dengan takrifan "SO merch tanpa `custom_booking`"). `booking_number` sedia tidak disentuh |
| **Voucher** | + `voucher_level` (Select: Booking/Cart); + child **Voucher Applicable Product Type** *(baharu)* (`product_type`, `reference`) merentas kategori | Scope semasa hanya trip/package/room category (disahkan `voucher.json`: `applicable_trips/packages/room_categories`); diperluas ke cart-level (kedudukan #6) |
| **Trip Addon Package** | + `activity_schedule` (Link Activity Schedule) | Aktiviti slot-based merujuk capacity berjadual, bukan `max_total_qty` sahaja |
| **Flight** | + `sellable` (Check) | Membezakan flight fulfilment (semasa) daripada flight jualan Fasa 2; `max_seat/seats_occupied` sedia jadi asas inventori |
| **Travel Settings** | + seksyen Commerce *(baharu)*: `enable_universal_cart`, `cart_hold_ttl_minutes`, `cart_expiry_days`, `guest_merch_checkout`, `wishlist_enabled` | Konfigurasi berperingkat (feature flag) selaras `max_cabins_per_booking` sedia |
| **Trip Group Date** | + `held_pax` (Int, custom) | Kaunter pax di-hold untuk dimasukkan dalam SUM overbooking gate (lihat 5.4 dan 8.4-R3) |
| **Trip Cruise Schedule** (behavior) | `cabin_available` dihitung sebagai `cabin_allotment − cabin_occupancy − SUM(hold aktif)` (medan sebenar pada baris `cabin_rates` Trip Package Price) | Elak double-sell antara hold dan booking semasa tingkap hold |
| **Sales Order** (custom) | + `custom_cart` (Link Cart) | Rantai audit cart→SO; tidak menyentuh `custom_booking` sedia |

**Kesan invariant (wajib nyata):** (1) **SO-GROSS + PE deductions KEKAL** — voucher cart-level diagihkan (allocation) kepada PE deductions SO terbitan oleh Checkout Orchestrator; tiada harga NET pada SO berubah. (2) **Currency axis** — Cart pin satu currency; `resolve_so_currency_context` (conversion_rate=1.0) terus digunakan semasa checkout. (3) **Overbooking gate FOR UPDATE KEKAL pengawal muktamad** — Reservation Hold hanyalah tingkap UX; gate pada TGD tetap berjalan pada saat konfirmasi, jadi kegagalan hold tidak boleh menyebabkan overbooking. (4) **Rantai `on_sales_order_change` tidak ditambah listener Cart** — status Cart dikemaskini eksplisit oleh orchestrator selepas SO dicipta, untuk mengelak beban cascade pada hook yang sudah padat.

### 4.3 Diagram entity-relationship

```
Sedia ada (ringkas)                             BAHARU (*)
─────────────────────────────                   ─────────────────────────────
Trip 1───n Trip Group Date (TGD)
              │ max/current_participants
              ├─1─n Trip Cruise Schedule ── Cruise Cabin (registry)
              │        └─ cabin_rates (Trip Package Price)
              └─1─n Flight Schedule
Trip 1───n Trip Package (TP)
              ├─ package_pricing (Trip Package Price: kategori × currency)
              └─ components (Trip Package Component BOM)
Trip Addon ── Trip Addon Package ── Trip Addon Package Rate
                    │
                    └──────────┐
                              │
*Cart 1───n *Cart Item ───────┼──▶ Trip Package / Trip Addon Package /
   │      (product_type       │    Item (merch) / *Activity Schedule / Flight
   │       discriminator)     │
   ├─1─n *Reservation Hold ───┘ (TGD allotment / Bin stock / slot / seat)
   └──▶ *Saved Quote (snapshot; Link Quotation)
*Wishlist (per user) ──▶ produk (Catalog Query Layer)

Booking 1───n Sales Order (custom_booking)      Booking 1───n Booking Reservation
   └ cart_source, order_type (ubah)                └─1─n Traveller (slot tetamu)
Sales Order ──▶ Payment Entry (deductions GROSS) ──▶ Stripe/Manual
```

### 4.4 Naratif relation DocType baharu

- **Cart → Cart Item**: parent-child; Cart Item ialah baris normalised dengan discriminator `product_type` — tiada polymorphic hack pada field link berasingan, setiap kategori ada field Link tersendiri supaya integriti referential Frappe (Link field) dikekalkan.
- **Cart → Trip Package / Trip Addon Package / Item / Flight / Activity Schedule**: hubungan rujukan longgar (reference); Cart TIDAK memegang kebenaran harga — snapshot harga hanya untuk paparan, dan checkout re-price server-side melalui enjin sedia (`_get_pricing_map`, Item Price), selari amalan `checkout_addons` hari ini.
- **Cart berbilang trip**: satu cart boleh memuatkan dua atau lebih trip/departure berbeza; orchestrator menghasilkan **satu Booking + satu SO per trip** (kerana `custom_booking` ialah field tunggal dan `_recompute_booking_status` mengagregat per Booking), baris merchandise dilampirkan pada SO trip pertama, dan voucher cart-level diagih proporsional merentas SO terlibat (kes "merentas beberapa SO" dalam R1).
- **Reservation Hold → Cart & sumber inventori**: setiap hold dipunyai satu Cart, menunjuk Dynamic Link kepada TGD (allotment kabin), Bin/Item (merchandise), Flight (`max_seat`) atau slot Activity Schedule. Semasa konfirmasi, hold ditanda Consumed dan slot tetamu sebenar diwujudkan melalui jalan sedia (Booking Reservation / Stock Reservation Entry) — hold tidak pernah menjadi tempahan.
- **Activity Schedule → Trip Addon Package**: addon aktiviti slot-based merujuk jadualnya; Trip Addon Package kekal unit komersial (harga, cutoff, scoping), Activity Schedule hanya pegangan kapasiti — pemisahan harga vs inventori yang sama seperti Trip Package vs TGD.
- **Saved Quote → Quotation & Cart**: Saved Quote memegang snapshot item + params + Link Quotation sebagai dokumen komersial ERPNext; apabila diterima, ia membelahkan Cart yang kemudian melalui Checkout Orchestrator biasa — supaya aliran wang tidak mempunyai cabangan kedua.
- **Wishlist → produk**: hubungan longgar melalui Catalog Query Layer; wishlist tidak menyimpan harga (elak basi), hanya rujukan + `added_on`.
- **Hotel Master (Fasa 2) → Trip Organizer / Trip Price Category**: hotel menjadi master domain kelima, dengan room type dipetakan kepada Trip Price Category supaya enjin harga slot sedia boleh digunakan semula tanpa varian Item.

---

## 5. Aliran Jualan (Task C — end-to-end; Task D — Cart; Task E — Booking Engine; Task F — Inventori)

> Kesimpulan pendirian: funnel jualan trip hari ini SEDIA BERFUNGSI hujung-ke-hujung (katalog → detail → wizard → OTP → SO/Booking → Stripe/Manual → portal) tetapi ia adalah *single-purpose funnel*: satu trip, satu SO, tiada cart, dan merchandise/addon berjalan melalui endpoint berasingan dengan pola berbeza. Cadangan: kekalkan seluruh backbone transaksi (SO-GROSS + PE deductions, currency axis, overbooking gate FOR UPDATE, rantai `on_sales_order_change`) dan suntik lapisan Commerce (Cart + Checkout Orchestrator + Product Type Strategy) di hadapan `confirm_booking` yang sedia terbukti.

### 5.1 Aliran jualan hujung-ke-hujung (Task C)

Aliran semasa (SEDIA ADA, disahkan kod) vs aliran sasaran (BAHARU, dilabel):

| # | Langkah | Halaman www | API whitelisted | DocType ditulis/dibaca | Validasi utama | Keadaan error |
|---|---------|-------------|-----------------|------------------------|----------------|---------------|
| 1 | **Visitor / Browse** | SEDIA: `/` (index.py), `/trips`, `/cruises`, `/tours`, `/cruise-schedule`, `/cruise`, `/tour` | SEDIA: konteks Jinja server-side; `get_public_merchandise(currency)` (merchandise.py:314, allow_guest) | BACA: Trip, Trip Group Date, Trip Package, Item | Filter q/destination/date/sort; currency dari geo axis | 0 hasil → empty state; destinasi tanpa inventori → "0 trips found" (isu audit GUI t15c) |
| 2 | **View Product Detail** | SEDIA: `/trips` → `/cruise-schedule` (modal pilih pakej) → `/booknow?trip=&package=` | SEDIA: `get_booking_details(trip_group_date, trip_package, ...)` (pricing.py:228, allow_guest) — harga live per kategori/currency | BACA: Trip Package Price, Trip Cruise Schedule (cabin_rates) | Kategori kabin tersedia untuk TGD | Kategori tiada rate dalam currency → disembunyikan |
| 3 | **Add To Cart** | SEDIA (wizard): `/booknow` Step 1–2, state `sessionStorage bnw_cart` — **BUKAN cart sebenar**. BAHARU: `/cart` | BAHARU: `add_to_cart`, `update_cart_item`, `remove_cart_item`, `get_cart` (Cart API, modul baharu `travel_booking/api/cart.py`) | BAHARU: tulis **Cart** + **Cart Item** (DocType baharu); BACA Trip Package, Trip Addon Package, Item | Server-side re-price setiap add (jangan percaya harga client — pola checkout_addons, addon_manager.py:354) | Rate tiada dalam currency cart → throw "not available in <currency>" (corak addon_manager.py:435) |
| 4 | **Checkout** | SEDIA: Step 2 Billing + Step 3 Payment dalam `/booknow`. BAHARU: `/cart` → `/checkout-bersatu` (satu halaman untuk semua product type) | SEDIA: `send_otp`/`verify_otp` (otp.py:19,177, rate-limited); BAHARU: `checkout_cart` (Checkout Orchestrator) | BACA: Terms and Conditions (gate `get_active_terms_record`, booking_engine.py:188); tulis Customer/Contact/Address via `_create_customer` (so_helpers.py:91) | T&C gate + OTP gate (cache `booking_email_verified_<email>`, booking_engine.py:229) + billing address 5 medan wajib (booking_engine.py:152–161) | OTP tamat 30 min → throw "session expired" (booking_engine.py:281); T&C versi lapuk → throw (booking_engine.py:195) |
| 5 | **Payment** | SEDIA: `/checkout?pr=` (Stripe Elements custom, timeout 5 minit) | SEDIA: `create_payment_intent` (stripe_checkout.py:168), `get_checkout_context(pr)` (440, allow_guest), `stripe_webhook()` (640 — sumber kebenaran status bayaran) | TULIS: Payment Request, Payment Intent Stripe; Manual: draft Payment Entry + File resit (`_create_manual_payment_entry`) | Deposit dikira server-side sahaja (booking_engine.py:770–800); `amount_paid` dari client diabaikan; online_min gate (booking_engine.py:781); cart bercampur: deposit terpakai pada baris trip sahaja, merchandise/addon dibayar penuh (peraturan §5.3) | Below Online Payment Minimum; `payment_setup_failed` dipulangkan tanpa gagalkan booking |
| 6 | **Booking Confirmation** | SEDIA: modal jaya wizard + emel status (`_send_status_email`); BAHARU: `/order-confirmed` universal (booking & merch) | SEDIA: return payload `confirm_booking` (booking_engine.py:1071–1090) | TULIS: Sales Order (custom_booking), Booking (status Pending, snapshot voucher_discount/referral_discount/pre_discount_total/applied_price_rules), Voucher Usage (`_use_voucher`, lock FOR UPDATE voucher.py:259) | Overbooking gate: `SELECT ... FOR UPDATE` pada Trip Group Date + `SUM(booked_pax)` vs `max_participants` (booking_engine.py:437–463) | "fully booked" / "Only N seat(s) left" (booking_engine.py:456–462) |
| 7 | **Customer Portal** | SEDIA: `/traveller/bookings`, `/booking?ref=`, `/billing?ref=`, `/travellers?ref=`, `/booking_addons`, `/transactions`, `/profile` | SEDIA: `get_booking_so_payments`, `create_payment_request` (portal_payment.py:374), `submit_manual_payment` (486) | BACA: Booking, SO, Payment Entry, Booking Reservation; tulis Booking Addon/Traveller | `_ensure_portal_user` (booking_engine.py:1717) cipta User semasa booking pertama; emel set-password sekali (booking_engine.py:950–960) | Ref booking hilang → redirect ke senarai (audit GUI t19) |

Aliran keseluruhan sedia ada (untuk rujukan, semua disahkan):

```
Visitor → /trips → /booknow (Step1 Rooms&PAX → Step2 Billing → OTP → Step3 Payment → Step4 Confirm)
        → confirm_booking (allow_guest, booking_engine.py:124-125)
            1. billing address wajib (152)      5. overbooking gate FOR UPDATE (437)
            2. T&C gate (188)                   6. SO insert+submit sbg Administrator (747)
            3. OTP gate (229)                   7. Booking Pending (837) + link custom_booking (942)
            4. pricing map + price rules (396)  8. _ensure_portal_user (950) + bayaran (988–1030)
        → /checkout?pr= (Stripe) ATAU resit manual ATAU Pay Later
        → webhook stripe_webhook / admin verify → on_payment_entry_submit
        → on_sales_order_change → _recompute_booking_status → Accepted
        → payment_status "Paid" → _activate_booking → Booking Reservation per pax
        → /traveller/* (bayar baki, addon, passport, dokumen)
```

**Yang SEDIA WUJUD dan kami kekalkan**: katalog 8 route, detail dengan harga live, OTP gate + Redis, Stripe checkout + webhook, manual transfer + resit, portal traveller penuh. **Yang BAHARU**: halaman `/cart`, Cart API, Checkout Orchestrator `checkout_cart`, halaman `/order-confirmed` universal, guest checkout merchandise (hari ini `create_merch_order` di `merchandise.py:386` TIDAK `allow_guest` — satu-satunya jurang guest). Nota: wizard sedia tidak mengumpul maklumat penumpang per guest sebelum bayar (audit GUI t09–t12); cadangan penanganannya di seksyen 6.2 dan 8.2.

### 5.2 Cart Design (Task D)

**(a) Universal Cart — keputusan reka bentuk: DocType persistent (baharu), BUKAN session.**

| Perspektif | SessionStorage (kini) | Cart DocType (cadangan) |
|---|---|---|
| Daya tahan | Hilang bila tab tutup | Kekal merentas peranti selepas login |
| Cross-category | Tidak (wizard trip sahaja) | Asli — Cart Item ber-discriminator `product_type` |
| Guest | Terhad | Cart guest diikat (bound) pada email ter-OTP semasa checkout |
| Audit/remarketing | Tiada | Boleh lapor cart terbengkalai (paralel `mark_abandoned_pending_bookings`) |
| Kos | Sifar | Scheduler cleanup + 1 pasangan DocType |

Sebab keputusan: sessionStorage `bnw_cart` (booknow.js:1219) menjadi punca jurang #1 (tiada cart persistent, tiada mixed-category). Cart sebagai DocType memberi identiti yang boleh di-`FOR UPDATE` (keperluan race-safety) dan boleh disimpan sebagai **Saved Quote** (Fasa 1). Medan teras Cart (baharu, selari skema §4.1): pemilik (`user` untuk yang login, atau `session_key` + `email` untuk guest), `currency` (pinned), `status` (Active/Merged/Converted/Expired), `expires_on`, `converted_sales_order`/`converted_booking`.

**(b) Struktur Cart Item (DocType baharu)** — satu child table pada Cart:
- `product_type` (discriminator): `trip_package | addon_package | merchandise | flight | activity`
- Reference links per jenis: `trip_package`, `trip_group_date`, `trip_addon_package` (Trip Addon Package), `item` (merchandise), `flight` (Flight)
- `params` (JSON): tarikh departure, pax breakdown (`main_guests/extra_beds/infants` — cermin struktur `selections` sedia), `room_category`, `room_privacy`, `cabin_no`
- `qty`, `unit_price_snapshot`, `line_total_snapshot`
- **Harga display vs re-price**: harga pada Cart Item adalah *indicative snapshot* untuk paparan; harga binding dikira semula server-side semasa checkout — kita meniru disiplin `checkout_addons` yang bertulis "Server-side re-price SEMUA baris dari DB (jangan sesekali percaya rate dari client)" (addon_manager.py:354–356).

**(c) Pricing structure — re-price semasa checkout, currency-pinned dari geo axis.** Cart dipinkan kepada satu currency semasa dicipta (resolusi `geo_currency`: param > cookie `rc_currency` > geo-IP CF-IPCountry > default axis). Semasa checkout: (1) sahkan currency declared dalam axis — throw jika tidak, jangan fallback senyap (corak addon_manager.py:382–399); (2) selesai setiap baris daripada sumber kebenaran — Trip Package Price per currency, Trip Addon Package Rate, Item Price; (3) `apply_price_rules` per unit. Kesahannya: SO kekal dikeluarkan oleh company yang sepadan currency melalui `_resolve_so_currency_and_rate` (booking_engine.py:622) dengan `conversion_rate=1.0` — tiada penukaran FX, invariant multi-company terpelihara.

**(d) Discount structure — tiga lapisan, susunan tidak berubah:**

```
Lapis 1  Travel Price Rule (per unit, BEST-ONLY, tiada stacking)
         → harga NET terus pada baris SO (sedia: booking_engine.py:398–404)
         → snapshot retail/price_rule_discount pada Booking (booking_engine.py:855–861)
Lapis 2  Voucher cart-level (BAHARU: diluaskan skop, mekanisme sama)
         → SO kekal GROSS; voucher_discount disimpan pada Booking (871)
         → diserap sebagai PE deduction ke Marketing Expenses (665–669)
         → dikira ATAS harga promo, subtotal baris yang match scope (voucher.py:23–28)
Lapis 3  Manual/staff discount
         → additional_discount_percentage standard ERPNext — slot yang sama
           digunakan harga net B2B hari ini (booking_engine.py:718–728)
```

Peraturan stacking (pendirian): price rule best-only per unit kekal; **satu voucher per cart** (kini pun satu per booking); referral kekal dikira atas baki selepas voucher (Tier B, booking_engine.py:570) tetapi HANYA pada baris trip; B2B dilarang voucher/referral sepenuhnya (guard sedia booking_engine.py:254–261 dikekalkan pada tahap orchestrator). Kesahan pada invariant: Lapis 2 tidak menyentuh SO sama sekali — hanya menambah baris deduction pada Payment Entry, maka rantai `on_sales_order_change → _recompute_booking_status` tidak berubah perilaku.

**(e) Promo code structure — pengukuhan Voucher (bukan DocType baharu).** DocType Voucher sedia ada `max_usage`, `max_usage_per_customer`, scope `Voucher Applicable Trip/Package/Room Category` (voucher.json:98–125) dan lock `FOR UPDATE` pada penggunaan (voucher.py:259). Yang ditambah (medan baharu pada Voucher): `voucher_level` (Booking/Cart), `applicable_product_types` (checkbox merentas kategori), `min_spend` per currency. `validate_voucher` diperluas menerima senarai baris cart berbanding `selections` trip sahaja — perubahan dos fungsi yang kecil kerana ia sudah menerima breakdown kabin.

### 5.3 Booking Engine (Task E) — SATU arkitektur untuk semua kategori

Pendirian: JANGAN tulis engine kedua. `confirm_booking` (booking_engine.py:124–1090, ±960 baris terbukti di produksi) digeneralisasikan menjadi **Checkout Orchestrator** yang mengambil Cart sebagai input dan mendelegasikan per product_type kepada **Product Type Strategy** (satu class Python per jenis, registry dalam modul baharu `travel_booking/api/checkout_orchestrator.py`):

```python
class ProductTypeStrategy:                    # (baharu — interface)
    def validate_selection(self, cart_item, ctx)      # capacity/scope/cutoff
    def price_selection(self, cart_item, ctx) -> lines # rate dari DB
    def reserve_or_hold(self, cart_item, ctx)          # Reservation Hold / stock
    def build_so_lines(self, cart_item, ctx)           # item ERPNext + custom fields
    def on_payment_success(self, booking, cart_item)   # fulfilment
```

**Fasa yang KEKAL 100%** (dipindahkan terus, dengan lokasi sedia): OTP gate + T&C gate + billing address gate (booking_engine.py:152–284); `_create_customer` (so_helpers.py:91); `_validate_selection_capacity` (pricing.py:697) — dipanggil oleh strategi trip; overbooking gate FOR UPDATE (booking_engine.py:437–463); penciptaan SO sebagai Administrator + `disable_rounded_total` (booking_engine.py:627–750); penciptaan Booking Pending + semua snapshot (837–931); `_ensure_portal_user` (950); ketiga-tiga laluan bayaran (988–1030); `frappe.db.commit()` + Telegram (1032–1058). Rantai doc events `on_sales_order_change` / `on_payment_entry_submit` (hooks.py:87–124) tidak disentuh langsung.

**Fasa yang BERUBAH**: (1) input — daripada parameter `selections`/`trip_package` terus dari wizard, kepada Cart + Cart Items (sumber tunggal); (2) pembinaan baris SO — daripada `_build_so_items` monolitik (so_helpers.py:302) kepada `build_so_lines` per strategi; (3) capacity check — daripada gate trip-level tunggal kepada `validate_selection` + `reserve_or_hold` per strategi (gate FOR UPDATE trip KEKAL untuk baris trip, strategi lain menambah gate masing-masing); (4) peraturan SO-per-cart (jadual di bawah) — campuran kategori dalam satu SO selamat selagi baris stok merch masih men-trigger `reserve_so_stock` pada `on_submit` (hooks.py:123, no-op untuk baris trip).

**Peraturan SO-per-cart (Fasa 1)** — menjawab bila satu cart menghasilkan lebih daripada satu SO:

| Bentuk cart | Hasil checkout |
|---|---|
| Satu trip (+ addon/merch) — kes majoriti | SATU SO + SATU Booking (`order_type` Trip Booking atau Mixed) |
| ≥2 trip/departure berbeza | SATU Booking + SATU SO **per trip** (`custom_booking` field tunggal; `_recompute_booking_status` mengagregat per Booking); baris merchandise dilampirkan pada SO trip pertama; voucher cart-level diagih proporsional merentas SO terlibat — inilah kes "merentas beberapa SO" dalam R1/§8.2 |
| Merchandise tulen (tiada trip) | SATU SO dengan `custom_cart` sahaja, TIADA Booking; pesanan muncul dalam My Orders (§6.1) |
| Aliran pasca-booking (addon lepas bayar, cabin sharing, amendment) | KEKAL SO berasingan seperti sedia (`custom_booking_addon` / SO baharu + credit note) — di luar cart; voucher tidak terpakai di sini (kekal seperti hari ini) |

**Addon dalam cart.** Kriteria jaya Fasa 1 "trip+addon+merch dalam satu checkout" dilaksana seperti berikut: addon yang dibeli serentak dengan trip menjadi baris item Trip Addon Package dalam SO cart yang sama; selepas Booking dicipta, orchestrator merekodkan **Booking Addon + Booking Addon Item** sedia untuk baris tersebut. Aliran pasca-booking `checkout_addons` (SO berasingan `custom_booking_addon`) kekal untuk pembelian lepas bayar — dua titik masuk, satu enjin harga.

**Deposit cart bercampur.** Peratus deposit dari Travel Settings terpakai pada baris trip sahaja; baris merchandise dan addon tidak berdeposit dan dibayar penuh. Payment Request tunggal meminta jumlah gabungan (deposit trip + penuh merch/addon) — sepadan dengan model PE `received + deductions = allocated` sedia.

**Penghantaran merchandise Fasa 1.** Delivery Note pukal `create_delivery_notes_for_trip` terikat TGD trip; bagi pesanan merchandise tulen (tiada trip), Fasa 1 menggunakan Delivery Note standard ERPNext yang dicipta secara manual/berkelompok oleh admin — automasi cukai/penghantaran menyusul Fasa 2. Ini had yang diterima secara sedar bagi guest merch checkout Fasa 1.

Contoh konkrit strategi (Fasa 1–2):

| Strategi | validate | price | reserve/hold | SO line | fulfilment |
|---|---|---|---|---|---|
| **Cruise Booking** | cabin allotment `cabin_rates` (Trip Package Price) + TGD capacity FOR UPDATE | model SLOT: 1 tetamu → `price_adult_single`; ≥2 → `price_adult`; extra bed → `price_upperberth` (pricing.py) | Reservation Hold pada baris cabin_rates + Cruise Cabin registry status | item `TRAVEL-PKG` per pax + `custom_room_category/cabin_no/pax_type` (sedia, booking_engine.py:730) | `_activate_booking` → Booking Reservation → `sync_cabin_availability` (hooks.py:131–141) |
| **Flight Booking** (Fasa 2, jualan) | `Flight.max_seat` vs `seats_occupied` (flight.json:178,194) | harga per seat FIT; GIT = rate group | hold seat counter (FOR UPDATE pada Flight) | item flight baharu + `custom_flight` | Booking Reservation link flight (medan sedia) |
| **Package Booking** (tour) | `_validate_selection_capacity` model AGE + TGD gate | `package_pricing` per kategori umur | Reservation Hold pada TGD | `TRAVEL-PKG` + `get_included_component_lines` (package_components.py:79, dipanggil booking_engine.py:488–503, komponen Included → baris tambahan) | komponen BOM → Delivery Note merchandise per TGD (sedia) |
| **Merch Order** | `_merch_in_stock` (merchandise.py:369) | Item Price per price list axis | reserve stok → `reserve_so_stock` pada SO on_submit (sedia) | item stok + qty | Delivery Note pukal `create_delivery_notes_for_trip` (merchandise.py:214) |
| **Addon (dalam cart)** | scoping/validity/sales cutoff + `max_qty_per_booking`/`max_total_qty` (addon_manager) | Trip Addon Package Rate per currency | kaunter `current_qty_sold` | item Trip Addon Package dalam SO cart yang sama | Booking Addon + Booking Addon Item selepas Booking dicipta (rekod sedia) |

Activity (Fasa 2) mengikuti corak sama dengan slot `Activity Schedule` (baharu); insurance/fee ialah baris non-inventori terus ke SO.

### 5.4 Inventory vs Non-Inventory (Task F)

| Kategori | Mekanisme kapasiti | Sumber kebenaran | Hold |
|---|---|---|---|
| **Cruise** | `cabin_allotment`/`cabin_occupancy`/`cabin_available` pada baris `cabin_rates` (Trip Package Price) + registry fizikal **Cruise Cabin** (Available/Blocked/Assigned/Maintenance) + gate TGD `max_participants` (0 = unlimited, booking_engine.py:432) | Trip Cruise Schedule, disinkron oleh `sync_cabin_availability` pada setiap perubahan Booking Reservation (hooks.py:131–141) | **Reservation Hold** (baharu) TTL |
| **Flight** | `max_seat` vs `seats_occupied` pada Flight (flight.json:178,194) | Flight doc | counter hold (Fasa 2) |
| **Merchandise** | stok ERPNext: Bin warehouse + `Stock Reservation Entry` dicetus `reserve_so_stock` semasa SO `on_submit` (hooks.py:123) | Bin/Stock Ledger ERPNext | sedia (reserve pada submit) |
| **Activity** (Fasa 2) | qty cap per slot → **Activity Schedule** (DocType baharu) dengan `capacity`/`booked_qty` per tarikh | Activity Schedule | Reservation Hold |
| **Insurance/fee** | TIADA inventori | — | tiada (baris SO terus) |

**Reasoning**: cruise memerlukan tiga lapisan kerana inventori bernuansa (allotment komersial ≠ bilik fizikal ≠ had pax trip) — ketiganya sedia ada dan tidak kami reka semula. Flight paling mudah (satu integer) tetapi hari ini hanya fulfilment; menjualnya hanya memerlukan gate + strategi. Merchandise sudah lengkap melalui ERPNext — jangan duplikasi. Insurance tak berbentuk kuantiti maka peraturan inventori akan menjadi kompleksiti palsu.

**Mekanisme Reservation Hold (DocType baharu, inti Fasa 1 untuk cruise):**
- **TTL**: default 15 minit (config di Travel Settings `cart_hold_ttl_minutes`), ditetap semasa checkout bermula — cukup untuk Stripe timeout sedia 5 minit + margin.
- **Penciptaan**: `reserve_or_hold` strategi mencipta Hold (qty pax + cabin category + TGD/schedule) DALAM transaksi yang sama dengan lock FOR UPDATE gate, sebelum SO insert.
- **Scheduler expiry**: tugas baharu frekuensi `["*/5 * * * *"]` — `release_expired_reservation_holds` memadam hold tamat yang tiada booking selesai; masuk dalam blok cron hooks.py (hooks.py:180) bersebelahan tugas sedia.
- **Release**: (a) expiry scheduler; (b) pembatalan checkout (`cancel_checkout_payment`, stripe_checkout.py:566); (c) kejayaan — Hold ditukar menjadi Booking Reservation oleh `_activate_booking` sedia.
- **UX tamat tempoh**: halaman `/checkout` memaparkan pemasa tingkap hold; apabila tamat, pengguna diberi mesej "Tempahan sementara telah tamat — pilihan anda disimpan, sila sahkan semula ketersediaan", baris trip yang di-hold ditanda `Released`, cart KEKAL (pilihan tidak hilang) tetapi ketersediaan disahkan semula apabila checkout dimulakan lagi (hold baharu, tanpa mengisi semula apa-apa). Lanjutan automatik tidak wujud; Desk boleh memantau hold aktif.
- **Hold jenis Stock (merchandise)**: digunakan semasa tingkap checkout cart merchandise (tulen/bercampur) sebagai penanda ketersediaan supaya dua checkout serentak tidak menjual stok yang sama; ia BUKAN reservasi sebenar — reservasi kekal `Stock Reservation Entry` yang dicetus `reserve_so_stock` pada SO on_submit. Aliran `create_merch_order` sedia (tanpa cart) kekal tanpa hold.
- **Interaksi dengan overbooking gate**: gate FOR UPDATE sedia (booking_engine.py:437–463) DIPANJANGKAN supaya `SUM(booked_pax)` termasuk pax dari Hold yang masih aktif untuk TGD berkenaan (medan `held_pax` pada TGD) — ini mengelakkan dua cart serentak melepasi gate dengan slot yang sama. Selepas booking selesai, pax dikira daripada Booking seperti biasa; Hold bagi baris tersebut dipadam. Invariant kekal: tidak ada laluan yang menulis `booked_pax` tanpa melalui gate berkunci.

---

## 6. Customer Journey & Portal (Task G)

Portal hari ini ialah 10 halaman `/traveller/*` (disenaraikan dalam `travel_booking/www/traveller/`: `bookings`, `booking`, `billing`, `travellers`, `booking_addons`, `manage_addon`, `transactions`, `profile`, `onbehalf*`) — semuanya berorientasikan **booking**, bukan **pelanggan**. Cadangan di bawah menyusun semula menu mengikut mental model pengguna (saya beli apa → saya pergi mana → saya bayar apa → saya simpan apa), sambil mengekalkan semua URL dan API sedia ada sebagai tunjang.

### 6.1 Cadangan menu portal penuh

| Menu | Fungsi terperinci | Pemetaan sedia ada vs baharu | Keperluan data |
|---|---|---|---|
| **My Bookings** | Senarai semua booking (status, baki, departure); detail per booking: kabin, pax, addon, amendment, invoice | **Sedia ada**: `/traveller/bookings` + `/traveller/booking?ref=`; API `get_bookings_list` (`api/portal_booking.py:1098`) dan `get_booking_data` (`api/portal_booking.py:413`). Tingkatan: papar sejarah Booking Amendment dan status stateroom secara native | Booking + agregat SO + Booking Reservation; tiada skema baharu |
| **My Orders** (merchandise) | Sejarah pesanan merchandise: item, harga, status bayar, status hantar (Delivery Note), resit | **Baharu (Fasa 1)** — hari ini langsung tiada (jurang audit #8). Halaman `/traveller/orders` + API `get_my_orders` *(baharu)*; asas query sedia ada pada `get_all_so_payments` (`api/portal_payment.py:26`) | SO yang ada baris `Item.is_public_merchandise = 1` tanpa `custom_booking` (pembeza daripada SO trip), Delivery Note, Payment Entry |
| **My Travellers** | Direktori tetamu disimpan (bukan semata per booking): butiran, passport + status expiry, dokumen visa; tambah/edit sebelum booking baharu | **Separa sedia ada**: `/traveller/travellers?ref=` hari ini scoped kepada satu booking. API `save_booking_traveller` (`api/portal_traveller.py:326`, `allow_guest` untuk co-traveller via token) sudah menyokong dedup passport (dhash, `portal_traveller.py:761`). Cadangan (Fasa 2): naikkan kepada direktori per-Customer | Traveller (medan personal/passport/health sedia ada) + pautan Customer↔Traveller |
| **Payments** | Satu tempat semua bayaran merentas SO trip, addon, merch; bayar baki (Stripe / manual transfer), muat naik resit; **pilihan "bayar deposit sahaja" eksplisit** | **Sedia ada**: `/traveller/transactions` + `/traveller/billing?ref=`; API `create_payment_request` (`api/portal_payment.py:374`), `submit_manual_payment` (`api/portal_payment.py:486`). Tingkatan: butang deposit eksplisit (geseran audit t12 — deposit 5% dipaparkan tetapi amaun perlu diedit manual) | Payment Request, Payment Entry, baki SO; min deposit peratus dari Travel Settings |
| **Documents** | Hub dokumen: resit, invoice, proforma PDF, e-ticket/penerbangan, status passport per tetamu, voucher trip | **Baharu sebagai hub (Fasa 2)** — keupayaan PDF sedia ada bertaburan dalam `get_document_pdf` (`api/portal_payment.py:746`) yang menyokong Payment Entry (resit), Sales Invoice, Proforma Invoice, dan Sales Order (proforma). Halaman `/traveller/documents` *(baharu)* hanya mengagregat | File attachments + Print Format sedia ada + medan flight pada Booking Reservation |
| **Wishlist** | Simpan trip/departure/merchandise; maklum bila harga berubah atau departure hampir penuh | **Baharu (Fasa 2)** — tiada langsung hari ini (grep `wishlist` dalam `travel_booking` kosong). DocType **Wishlist + Wishlist Item** *(baharu, pola dipinjam webshop)* — rujuk §7.3 | Wishlist (baharu): user/customer + item (Trip/TGD/Item) + currency semasa disimpan |
| **Saved Quote** | Simpan pilihan (trip + TGD + pakej + pax + kategori bilik + currency) sebagai sebut harga; convert kepada booking kemudian | **Baharu (Fasa 1)** — hari ini tiada aliran quote (terus ke SO; Travel Inquiry hanyalah lead). Guna **ERPNext Quotation** dengan custom flag *(baharu)* — Quotation belum pernah digunakan dalam app (grep kosong), jadi tiada pertembungan. Convert WAJIB re-price server-side melalui Checkout Orchestrator, bukan terima rate Quotation mentah-mentah | Quotation + baris TRAVEL-PKG snapshot + params pilihan (TGD, kategori, pax mix) |

**Keputusan:** My Orders, Wishlist, dan Saved Quote ialah tiga tambahan sebenar; empat lagi ialah penyusunan semula/tingkatan halaman sedia ada. Ini meminimumkan risiko regresi kerana rantai `on_sales_order_change` tidak disentuh.

### 6.2 Journey map pelanggan empat fasa

| Fasa | Langkah | Touchpoint | Geseran diperhati audit GUI |
|---|---|---|---|
| **Pre-purchase** | Temui → banding → simpan | `/` (rewrite domain), `/trips`, `/cruise-schedule`, halaman detail trip `/<trip-route>` | Homepage kosong ("No featured tours yet") tetapi statistik "300+ Tours" (katalog sebenar 17 trips); harga kad SGD tak konsisten dengan MYR (nisbah 2.49–3.10) dan tarikh "Sail" berubah antara mata wang untuk trip sama; sailing 14 Nov 2026 dijual di `/trips` tetapi tiada dalam `/cruise-schedule`; penapis Destination menukar URL serta-merta tetapi hasil hanya selepas klik Search; destinasi tanpa inventori (Sarajevo dll → 0 hasil); "Start from RM2,990" vs butang pakej default RM3,220; tiada wishlist/compare |
| **Purchase** | Pilih kabin/pax → billing → bayar → confirm | `/booknow` (wizard 4 langkah, sessionStorage `bnw_cart`), `/checkout?pr=` (Stripe Elements) | Wizard tidak kumpul maklumat penumpang (nama/DOB/passport) sebelum pembayaran — hanya bilangan pax + billing contact; tiada pilihan "bayar deposit sahaja" eksplisit; voucher hanya berkesan di sini (addon/merch terkecuali) |
| **Post-booking** | Lengkapkan tetamu → dokumen → addon/amendment → bayar baki | `/traveller/*`, `/guest_passport?token=`, `/set-password` | Avatar pengguna papar "?" pada `/traveller/billing` tetapi "GA" di halaman lain; halaman billing/booking_addons terus redirect tanpa `ref` yang sah; maklumat penumpang dikejar selepas bayar (dorongan email, bukan dalam wizard) |
| **Post-trip** | Muat turun dokumen → resit → review/re-book | `/traveller/transactions`, `get_document_pdf`, email status Completed | Tiada review/UGC, tiada wishlist, tiada dorongan re-book — perjalanan berakhir senyap pada status Completed |

Aliran maklumat penumpang selepas bayar adalah **reka bentuk sedar** (OTP + PaymentIntent dulu, passport kemudian via token co-traveller — `api/otp.py`, `save_booking_traveller` allow_guest), tetapi ia meninggalkan geseran "documents incomplete" yang audit lihat sebagai jurang. Cadangan Fasa 1: wizard mengumpul nama penuh + DOB minimum per pax sebelum bayar (validasi ringan, bukan OCR penuh).

### 6.3 Keperluan B2C vs B2B Partner vs On-behalf Staff

Peranan yang wujud (disahkan): portal user dengan role `Customer`; **Travel B2B Partner User** (medan `access_level`: View/Docs/Full); **Travel On Behalf Role** (medan `booking_channel` Affiliate/Staff, `access_level` View/Docs/Full, `access_scope` Own Bookings/All Bookings).

| Dimensi | B2C (Customer) | B2B Partner | On-behalf Staff/Affiliate |
|---|---|---|---|
| Matlamat portal | Urus perjalanan sendiri + keluarga | Urus booking pelanggan mereka, billing net-rate | Bantu customer mencipta/mengurus booking secara langsung |
| Paparan harga | GROSS (SO) | Net-rate selepas `package_discounts` → `additional_discount_percentage` pada SO; harga boleh disembunyikan mengikut `access_level` (`_price_hidden_for`, `api/portal_booking.py:182`) | Ikut harga customer sebenar |
| Halaman | `/traveller/*` | Portal B2B khusus *(Fasa 2, baharu)*; hari ini hanya mirror terhad | `/traveller/onbehalf*` + `get_on_behalf_bookings_list` (`api/portal_booking.py:1267`), `get_staff_bookings_list` (`api/portal_booking.py:1415`) |
| Voucher/referral | Ya (wizard utama) | **Dilarang** (B2B tidak boleh guna voucher/referral — invariant enjin booking) | Tidak (staff tidak menyerap promo peribadi) |
| OTP | Wajib | Bypass | Bypass |
| Keperluan khas | Wishlist, saved quote, dokumen, PDPA (`request_data_action`, `api/portal_profile.py:161`) | Export senarai pax, invoicing company-level, laporan jualan per pakej | Audit trail tindakan bagi pihak customer; skop `All Bookings` untuk operasi harian |

**Keputusan:** satu codebase portal dengan tiga lapisan kawalan (harga disembunyikan, set tindakan, skop data) — bukan tiga portal berasingan. Ini selari dengan pola `_booking_action_allowed` / `_so_action_allowed` sedia ada yang mengambil `required_level`.

---

## 7. Pemetaan ERPNext (Task H)

### 7.1 Jadual pemetaan dokumen ERPNext

| Dokumen ERPNext | Status penggunaan | Sebab |
|---|---|---|
| **Item** | Guna dengan custom fields | Item servis `TRAVEL-PKG` + item `Trip Addon Package` + merchandise; custom field `is_public_merchandise` menanda katalog awam (`api/merchandise.py:98-99`); Item Group Merchandise. Trip/cruise **bukan** Item (kedudukan diluluskan #2) |
| **Item Variant** | TIDAK digunakan (custom dalam travel_booking) | Sifar rujukan dalam kod (grep kosong). Cadangan Fasa 1: guna untuk merchandise size/colour — inilah satu-satunya tempat variant semula jadi |
| **Product Bundle** | TIDAK digunakan | Diganti **Trip Package Component** BOM custom: bundle ERPNext explode pada SO dan tiada konsep `inclusion_mode` (Included/Optional/Post-booking Addon) atau pautan `merchandise_item` untuk fulfilment per TGD |
| **Item Price** | Guna built-in (merchandise sahaja) | `ensure_item_price` (`api/merchandise.py:104`). Harga trip/addon TIDAK melalui Item Price — melalui Trip Package Price / Trip Addon Package Rate kerana harga berubah mengikut kategori bilik × pax type × currency × slot |
| **Price List** | Guna built-in sebagai axis | `Travel Currency Account.selling_price_list` memetakan currency → price list per company (`travel_currency_account.json` field `selling_price_list`) |
| **Pricing Rule** (ERPNext) | TIDAK digunakan | Diganti **Travel Price Rule** custom: scoping domain travel (trip/group date/package/room category/guest type), best-only tanpa stacking, snapshot ke `Booking.applied_price_rules`; ERPNext Pricing Rule tidak memahami pax-type/slot cruise |
| **Sales Order** | Guna dengan custom fields (backbone) | `custom_booking`, `custom_booking_addon`, dan per-baris `custom_room_category`, `custom_cabin_no`, `custom_pax_type`, `custom_trip_package`, `custom_trip_group_date`, `custom_room_privacy` (dijamin oleh patch v39, `patches/v39_so_item_structured_cabin_fields.py`); dibina sebagai Administrator (`api/booking_engine.py:628`) |
| **Sales Invoice** | Guna built-in sepenuhnya | Auto-invoice `_maybe_auto_invoice_so` + jaringan `reconcile_missing_invoices` (scheduler harian, `hooks.py:169`); Print Format custom sahaja |
| **Payment Entry** | Guna built-in + corak deductions custom | Manual transfer + settlement Stripe; invariant GROSS: `received + deductions = allocated`, deductions ke akaun Marketing Expenses (`_resolve_cashback_discount_account`, `api/so_helpers.py:637`) |
| **Payment Request** | Guna built-in sebagai rekod | Dicipta untuk rekod + `set_as_paid()` via webhook; URL `/checkout?pr=` custom, BUKAN `pr.get_payment_url()` (`api/stripe_checkout.py:332-338`) |
| **Stock Reservation Entry** | Guna built-in sepenuhnya | `reserve_so_stock` pada SO on_submit (`hooks.py:123`, `api/merchandise.py:143`) |
| **Delivery Note** | Guna built-in sepenuhnya | Pukal per TGD: `create_delivery_notes_for_trip` (`api/merchandise.py:214`) |
| **Quotation** | TIDAK digunakan hari ini | Sifar rujukan (grep kosong). Cadangan: guna untuk **Saved Quote** (kedudukan diluluskan #8) dengan custom flag |
| **Sales Return** | Guna built-in | Credit note bagi amendment: `make_sales_return` (`api/booking_amendment_api.py:272`) |
| **Proforma Invoice** | Guna built-in | Doctype ERPNext dipaut ke SO; PDF dijana on-submit dan dimuat turun via `get_document_pdf` (`api/portal_payment.py:802-836`) |
| **Customer / Contact / Address** | Guna built-in + Dynamic Link | `_create_customer`, `_ensure_contact_customer_link`, `_upsert_customer_billing_address` (`api/so_helpers.py:91-199`) |

### 7.2 Apa yang patut built-in vs custom

**Guna built-in ERPNext:** seluruh tulang belakang transaksi (SO → SI → PE/PR → DN/SRE), Customer/Contact/Address/User, Item + Item Variant + Item Price + Price List untuk merchandise, Company/Currency axis, Payment Gateway/Stripe Settings, Terms and Conditions, Sales Partner (affiliate), Print Format framework, Quotation (Saved Quote), Sales Return, Proforma Invoice.

**Kekal custom dalam travel_booking:** model produk domain (Trip → Trip Group Date → Trip Package → Trip Package Price → Trip Price Category), inventori cruise (Trip Cruise Schedule + Cruise Cabin registry), Travel Price Rule, Voucher + Voucher Usage, Booking + Booking Reservation + Booking Addon, Traveller, set Flight, Travel B2B Partner, dan lapisan Commerce baharu (Cart, Cart Item, Checkout Orchestrator, Product Type Strategy, Reservation Hold, Catalog Query Layer).

Garis pemisahnya: **ERPNext mengurus wang dan benda fizikal; travel_booking mengurus makna perjalanan.** Apa-apa yang perlu memahami "slot kabin pada sailing tertentu untuk pax type tertentu" tidak boleh dipaksa ke dalam Item/Price List tanpa mengorbankan model harga slot/umur yang sedia terbukti.

### 7.3 Kenapa webshop TIDAK diadopsi

Webshop wujud dalam bench tetapi tidak dipasang pada site. Empat hujah menolak adopsi:

1. **Model cart bercanggah dengan backbone SO.** Cart webshop ialah Quotation terbuka jenis "Shopping Cart" (`apps/webshop/webshop/webshop/shopping_cart/cart.py:377-383`) yang menetapkan harga melalui Item Price/Price List dan ditempatkan sebagai pesanan Item tunggal. travel_booking pula membina SO secara programatik dengan custom fields per baris dan menjadikan SO sebagai source of truth harga melalui `on_sales_order_change` (`hooks.py:115-124`). Mengambil webshop bermakna dua sumber kebenaran harga (Quotation vs snapshot Booking) — merosakkan invariant SO-GROSS + PE deductions serta rantai doc events yang bergantung pada `custom_booking`.
2. **Model produk tidak serasi.** Website Item ialah lapisan merchandising atas Item; cruise/departure secara prinsip tidak boleh menjadi Item tanpa mewujudkan ribuan Item per sailing — ditolak tegas dalam kedudukan diluluskan #2.
3. **Konflik template.** Halaman web travel_booking menggunakan `templates/base_travel.html` custom (bukan `web.html` Frappe); webshop membawa blok template dan asetnya sendiri — permukaan penyelenggaraan tambahan dan risiko konflik navbar/base layout yang audit lihat sudah tidak konsisten antara halaman.
4. **Faedah bertindih.** webshop tidak menyelesaikan jurang sebenar (cart merentas kategori, promo cart-level, guest merch checkout) kerana modelnya Item-sahaja.

**Konsep webshop yang berbaloi dipinjam sebagai pola** (bukan kod): **Website Item** sebagai pola merchandising/SEO per produk untuk katalog merchandise; **wishlist** sebagai pola koleksi per-pengguna; **item review** sebagai pola UGC post-trip (Fasa 3); **homepage_featured_product** sebagai pola featured catalog; **recommended_items** sebagai pola cross-sell addon. Ini senarai DocType webshop yang disemak: `website_item`, `wishlist`, `item_review`, `website_offer`, `recommended_items`, `homepage_featured_product`.

### 7.4 Invariant yang mesti kekal

| Invariant | Mekanisme sedia ada | Implikasi ke atas cadangan |
|---|---|---|
| **SO = source of truth harga** | `on_sales_order_change` pada on_update/on_update_after_submit/on_cancel/on_trash → `_recompute_booking_status` (`api/booking_engine.py:1104`) | Cart/checkout/merch/saved-quote convert SEMUA mesti berakhir sebagai SO dengan custom fields yang sama; tiada harga disimpan pada dokumen lain sebagai kebenaran |
| **Snapshot sync + overbooking gate** | `SELECT ... FOR UPDATE` pada TGD + `SUM(booked_pax)` vs `max_participants`; sync occupancy via doc events Booking Reservation (`hooks.py:131-141`) | Reservation Hold (baharu) mesti berexpiry dan release tanpa pernah menulis `booked_pax`; gate kekal tunggal di Checkout Orchestrator |
| **Auto-invoice** | `_maybe_auto_invoice_so` + `reconcile_missing_invoices` (scheduler harian) | Semua modul Product Type Strategy melalui laluan invoice yang sama — tiada laluan bayaran yang memintas SI |
| **Currency axis multi-company** | `resolve_so_currency_context` dengan `conversion_rate = 1.0`, tiada penukaran FX (`api/so_helpers.py:439`) | Cart currency-pinned dari geo axis; re-price semasa checkout dalam currency cart; Item Price kekal per price list axis |

```
[Pelanggan] → Cart (baharu) → Checkout Orchestrator (baharu)
                                  │  Product Type Strategy per product_type
                                  ▼
                    Sales Order (custom fields) ── source of truth HARGA
                         │
        ┌────────────────┼────────────────────┐
        ▼                ▼                    ▼
  Payment Request   Booking snapshot     Sales Invoice (auto)
  + PE (GROSS +     (payment_status,     + reconcile scheduler
  deductions)        booked_pax)
```

**Kesimpulan:** portal dicapai dengan tiga tambahan (My Orders, Wishlist, Saved Quote) dan penyusunan semula yang lain; ERPNext mapping mengekalkan pattern sedia ada — built-in untuk wang/barang, custom untuk domain perjalanan — dan webshop ditolak atas sebab seni bina, bukan sekadar preferens.

---

## 8. Gap Analysis: dari Booking Management ke Sales Platform (Task J)

Kedudukan diluluskan pemilik produk mengekalkan ERPNext SO/SI/PE sebagai backbone dan menambah lapisan Commerce dalam `travel_booking`. Gap di bawah dinilai terhadap kod sebenar: `confirm_booking` (`travel_booking/api/booking_engine.py:124-125`), wizard `booknow.js` (5,534 baris, `travel_booking/public/js/booknow.js`), voucher (`travel_booking/api/voucher.py`), merchandise (`travel_booking/api/merchandise.py`), dan senarai DocType dalam `travel_booking/travel_booking/module_travel_booking/doctype/` — tiada Cart, Activity Schedule, hotel master, atau Quotation-based quote wujud hari ini.

### 8.1 Feature yang perlu DITAMBAH

| # | Feature baharu | Keutamaan | Kesan jualan | Nota invariant |
|---|---|---|---|---|
| A1 | **Cart + Cart Item** (baharu) — persistent, cross-category (`product_type`: trip_package / addon_package / merchandise / flight / activity), currency-pinned | P0 | Buka upsell cross-category; asas semua fasa lain | Cart bukan dokumen kewangan; SO kekal GROSS, tiada kesan |
| A2 | **Checkout Orchestrator** (baharu) — generalisasi `confirm_booking` dengan Product Type Strategy per kategori | P0 | Satu funnel untuk semua produk; matikan kompleksiti wizard | Guna semula gate sedia: OTP, T&C, `SELECT ... FOR UPDATE` (`booking_engine.py:445`), `_recompute_booking_status` |
| A3 | **Promo Engine peringkat cart** (baharu, `api/promo_engine.py`) — voucher merentas kategori pada peringkat cart | P0 | KPI: AOV cart bercampur melebihi AOV booking tulen (baseline diukur sebelum pelancaran); promo konsisten merentas produk | Diserap sebagai PE deductions selepas Stripe (`_settle_order_discount_residue`) — invariant kekal |
| A4 | **Reservation Hold** (baharu) — hold berexpiry (default 15 minit, range 15–30 min) ke atas slot TGD/kabin/merch semasa checkout | P0 | Kurangi kegagalan bayar akibat kehabisan slot; pengalaman OTA standard | WAJIB bergabung dengan overbooking gate FOR UPDATE (lihat 8.4-R3) |
| A5 | **Saved Quote** (baharu, berasaskan Quotation ERPNext) | P1 | Leads bertukar tanpa tekanan masa; tutup jurang Travel Inquiry | Quotation tidak sentuh SO; apabila diterima, jana SO melalui Checkout Orchestrator |
| A6 | Guest checkout merchandise — buka `create_merch_order` kepada guest dengan email+OTP | P1 | Hilangkan halangan login (kini perlu login, disahkan `merchandise.py:386` tanpa `allow_guest`); penghantaran merch tulen Fasa 1 = Delivery Note standard manual (lihat §5.3) | `_create_customer` sedia boleh diguna semula; inventori Bin/SRE tidak berubah |
| A7 | Portal **My Orders** (merchandise) | P1 (Fasa 1) | KPI: % pelanggan merchandise berulang (baseline 0 hari ini — tiada sejarah pesanan langsung) | Baca sahaja (SO + Delivery Note); tiada kesan invariant |
| A8 | **Wishlist** (DocType baharu) | P2 (Fasa 2) | KPI: kadar simpan-ke-convert wishlist (diukur selepas dilancarkan) | Baca sahaja melalui Catalog Query Layer; tiada kesan invariant |
| A9 | **Activity Schedule** slot (baharu) + **Hotel Master** (baharu) | P2 (Fasa 2) | Perluaskan katalog jualan; sokong pakej ground yang kaya | Produk baharu melalui Product Type Strategy baharu; SO tetap satu baris per unit |
| A10 | Refund automation (Stripe refund API), cukai/penghantaran merchandise, search/faceting (**Catalog Query Layer**) | P2–P3 | Operasi berskala; discoverability | Refund mesti jana Credit Note sedia (Sales Return) supaya ledger kekal konsisten |
| A11 | API layer B2B/OTA, marketplace multi-supplier, loyalty/reviews | P3 | Saluran jualan baharu | Semua melalui Checkout Orchestrator sahaja — tiada laluan tulis terus ke SO |

Nota KPI: angka baseline (AOV, retensi) belum diukur dalam dokumen ini — ia mesti diukur daripada SO sedia sebelum Fasa 1 bermula; dokumen ini sengaja tidak mengarang unjuran angka.

### 8.2 Feature yang perlu DIUBAH

| Sedia | Masalah (bukti kod) | Cadangan perubahan | Kesan invariant |
|---|---|---|---|
| Wizard `/booknow` 4 langkah (`booknow.js`, 5,534 baris; state `sessionStorage bnw_cart` di `booknow.js:1219`) | Monolit front-end; logik state tersebar; tiada cart kekal; kegagalan tab = hilang pilihan | Jadi **klien Cart**: langkah Rooms & Passengers → isi Cart Item; checkout → Checkout Orchestrator. Strangler fig: `booknow.js` dikecilkan secara berperingkat, Step Billing/Payment diganti komponen cart bersama | Backend `confirm_booking` dikekalkan sebagai satu strategy (trip_package); overbooking gate tidak disentuh |
| Voucher hanya booking utama (disahkan kod: diskaun voucher hanya dikira dalam `confirm_booking`; SO addon/merch/cabin-sharing tidak menerima voucher) | Addon/merch/cabin-sharing SO tidak boleh guna voucher — tidak adil pada pelanggan, sukar diterangkan | Voucher dinaik ke **cart-level**: diskaun diagihkan ke SO terlibat mengikut porsi subtotal; setiap SO kekal GROSS penuh, diserap sebagai PE deductions | Invariant SO-GROSS KEKAL; hanya tempat penyerapan bergerak ke orchestrator |
| Pengurusan traveller terikat per booking (portal `travellers?ref=`) | Traveller sama dimasukkan semula setiap booking; passport OCR berulang | **Direktori Traveller** per Customer (My Travellers): pilih dari direktori semasa checkout; Booking Reservation terus link traveller sedia | `passport_link_token` untuk co-traveller kekal; cleanup passport 6 bulan (scheduler) terus berkesan |
| `get_public_merchandise` katalog flat limit 100 (disahkan `merchandise.py`) | Tiada search/facet/paginasi | **Catalog Query Layer** (baharu): satu antara muka query berparameter untuk trip + merchandise + aktiviti | Baca sahaja; tidak sentuh harga (harga live kekal via `get_booking_details`) |
| Refund manual (flag + log sahaja) | Operasi lambat, mudah tertinggal; status `Request Refund` melekat | Automasi Stripe refund + jana Sales Return + sync `payment_status` melalui `on_sales_order_change` | Rantai doc events sedia dipakai — tambah handler refund dalam modul sama |
| Wizard tidak kumpul maklumat penumpang sebelum bayar (audit GUI t09/t12) | Risiko pembayaran tanpa data pax; kerja manual selepasnya | Kumpul pax ringkas (nama/DOB) dalam cart checkout; passport penuh selepas bayar melalui `guest_passport?token=` sedia | Tiada perubahan skema; hanya turutkan urutan UX |

### 8.3 Dibuang / Dikonsolidasi (berperingkat, bukan pemusnahan)

| Item | Penilaian | Tindakan |
|---|---|---|
| Dua mekanisme multi-domain bertindih: app `multi_domain_routing` (`before_request`, `page_renderer` dalam `multi_domain_routing/hooks.py`) vs rewrite dalaman `travel_booking/www/index.py:42-44` (config `multi_domain.mappings`) | DUA laluan resolve domain = branding/route boleh berlawan; sukar debug (lihat isu navbar/cruise 503 dalam audit GUI) | **Kekalkan app `multi_domain_routing`** sebagai satu-satunya mekanisme (page renderer + branding per domain); buang mapping domain dari `Travel Website` config secara berperingkat. Migrasi mappings → data app, kemudian matikan blok `index.py` |
| `sessionStorage bnw_cart` (`booknow.js:1219,3025`) | State hilang antara tab/peranti; tidak boleh disimpan atau dikongsi | Ganti dengan Cart server-side (A1); `bnw_cart` jadi fallback baca-sekali semasa tempoh migrasi, kemudian dibuang |
| Travel Inquiry vs Saved Quote | Travel Inquiry = lead capture sahaja (tiada harga, tiada expiry); Saved Quote = Quotation bernilai + expiry + boleh ditukar | **Kekalkan KEDUA-DUA tetapi disatukan corak**: Travel Inquiry kekal sebagai top-of-funnel (belum ada pilihan pax), tetapi setiap inquiry yang punya pakej+tarikh ditawarkan auto-convert ke Saved Quote. Jangan buang Travel Inquiry — pangkalan lead sedia bernilai |
| `webshop` app dalam bench (tidak dipasang pada site) | Model cart Item/simple-product + Quotation bercanggah dengan backbone SO | Kekal TIDAK dipasang; guna semula konsep (wishlist UX, item review) sahaja. Nyatakan dalam ADR supaya tidak "dibantu" pada masa hadapan |
| Dua halaman katalog cruise bertindih (`/cruise` vs `/cruises`) dan navbar tidak konsisten antara domain (audit GUI t01/t02) | Kekeliruan UX + SEO pendua | Konsolidasi kepada satu route per vertical selepas mekanisme domain tunggal stabil; redirect 301 |

### 8.4 Risiko Arkitektur (J4) dan Mitigasi

```
 Pelanggan ──> Cart (A1) ──> Checkout Orchestrator (A2)
                                 │  strategy per product_type
                                 ├─ validate ─> price ─> HOLD (A4) ─> baris SO ─> fulfilment
                                 ▼
                 [ KEKAL: OTP gate | T&C | _create_customer | FOR UPDATE gate ]
                                 ▼
                 Sales Order (GROSS) ── doc_events (hooks.py:116-119) ──> on_sales_order_change
                                 ▼
                 Payment Entry (deductions) ─> Booking/Reservation/Addon/DN
```

| # | Risiko | Keterukan | Mitigasi |
|---|---|---|---|
| R1 | **Kompleksiti SO-GROSS/PE-deduction**: voucher cart-level mesti diagih merentas beberapa SO tanpa memecah `received + deductions = allocated` | Tinggi | Peraturan pengagihan ditetapkan dalam satu modul (allocasi proporsional subtotal, rounding ke SO terakhir); unit test atas `_settle_order_discount_residue` diperluas ke kes multi-SO; larangan keras: tiada diskaun ditulis pada baris SO |
| R2 | **Migrasi `booknow.js` (5,534 baris)**: wizard ialah satu-satunya laluan hasil hari ini | Tinggi | Strangler fig: Cart API diperkenalkan di belakang UI sedia (langkah 1 kekal); wizard lama kekal live sehingga funnel cart baharu lulus parity test, kemudian DIBERSARAKAN (UI `/booknow` kekal di atas Cart API). Senarai penuh kriteria parity: (i) harga baris & total identik, (ii) deposit 5% tepat, (iii) OTP gate lulus/gagal seragam, (iv) overbooking gate berkelakuan sama termasuk uji race, (v) voucher/price rule menghasilkan snapshot Booking yang sama, (vi) dokumen dicipta sama (Booking/Booking Reservation/SI/emel status). Pelulus go/no-go: pemilik produk; harness dijalankan QA pada setiap tahap. Rollback = arahkan semula ke `/booknow` |
| R3 | **Reservation Hold vs overbooking gate race**: hold yang tidak dikira dalam `SUM(booked_pax)` menjadikan gate `FOR UPDATE` (`booking_engine.py:445`) boleh lalu walaupun slot sudah di-hold | Tinggi | Hold direkodkan dalam medan `held_pax` pada TGD (baharu) dan SUM gate dikemas kini untuk memasukkannya; expiry via scheduler sedia + lazy-expiry pada baca; satu transaksi DB sahaja yang mencipta hold |
| R4 | **Rantai doc events rapuh** (`hooks.py:116-119`): setiap laluan baharu yang mencipta SO secara automatik mencetus `on_sales_order_change` → `_recompute_booking_status` | Tinggi | SEMUA laluan jualan baharu WAJIB melalui Checkout Orchestrator (tiada `frappe.get_doc("Sales Order").insert()` terus dari modul lain); tambah guard dalam `on_sales_order_change` untuk SO tanpa `custom_booking` (skip selamat); regression test rantai penuh: SO→PE→Booking→Reservation→Addon |
| R5 | **Dual multi-domain** | Sederhana | Seperti 8.3: satu mekanisme sahaja; audit GUI (navbar berbeza, cruise 503) menunjukkan gejala sebenar |
| R6 | **Godaan Item Variant**: menukar Trip/Cruise kepada Item Variant ERPNext nampak "standard" tetapi memusnahkan model slot/allotment | Sederhana | Kedudukan diluluskan #2: cruise/departure kekal master domain; hanya merchandise guna Item (+Variant size/colour). Dokumen ADR jangka panjang |
| R7 | **Satu currency per cart** (currency-pinned dari geo axis, tiada FX) | Rendah–Sederhana | Terima sebagai constraint Fasa 1 (jadual harga per currency sedia wujud); UI jelas "cart dalam MYR"; tukar currency = kosongkan cart. Jangan bina konversi FX dalam cart — `resolve_so_currency_context` kekal conversion_rate=1.0 |

---

## 9. Roadmap Pelaksanaan (Task J)

### 9.1 Jadual ringkas

| Fasa | Skop teras | Deliverable | Kebergantungan | Effort | Success criteria |
|---|---|---|---|---|---|
| **1 — Asas jualan** (bulan 1–3) | Universal Cart + Checkout Orchestrator + promo cart-level + guest merch checkout + Saved Quote + Reservation Hold + portal My Orders | DocType Cart/Cart Item/Reservation Hold/Saved Quote (baharu); modul `cart.py`, `checkout_orchestrator.py`, `promo_engine.py` (baharu); halaman `/cart`, `/quote` (baharu); portal `orders`, `quotes` (baharu) | Tiada (asas); Stripe/OTP/T&C diguna semula | **L** | 1 booking end-to-end melalui cart (trip+addon+merch dalam satu checkout); wizard lama masih boleh berfungsi (parity); voucher berkesan merentas kategori; hold tamat tempoh dinyahkan dengan betul; 0 runaway pada `on_sales_order_change` |
| **2 — Kedalaman produk & operasi** (bulan 4–7) | Activity Schedule slot, hotel master, flight sebagai produk jualan, search/facets (Catalog Query Layer), refund automation, cukai/penghantaran merchandise, portal B2B self-service, Wishlist | DocType Activity Schedule/Hotel Master/Wishlist (baharu); flight strategy jualan; modul refund otomatik; taxes & shipping rules; portal B2B; portal `wishlist`, direktori My Travellers, hub Documents (baharu) | Fasa 1 (cart + orchestrator wajib sedia) | **L** | Produk aktiviti/hotel boleh dibeli dalam cart sama; refund Stripe memulangkan status `Refunded` + Sales Return auto; B2B partner boleh self-quote net-rate |
| **3 — Skala & ekosistem** (bulan 8–12+) | Marketplace multi-supplier, API layer B2B/OTA, corporate booking, loyalty/reviews | Naik taraf Trip Organizer sebagai supplier master (field `supplier_type`/`is_marketplace_seller` baharu — bukan DocType baharu); API keys + rate limit (baharu); DocType Corporate Account (baharu); loyalty engine | Fasa 1+2; keputusan bisnes komersial | **L** | Order OTA masuk melalui API mencipta SO lengkap dengan invariant sama; ≥1 supplier luar aktif; loyalty poin ditebus sebagai PE deduction |

**Legend effort & andaian pasukan.** Effort: **S** ≤ 2, **M** 2–4, **L** 4–8 orang-bulan (andaian perancangan, bukan sebut harga). "L" pada ketiga-tiga fasa ≈ 4–8 orang-bulan setiap satu; cadangan pasukan minimum: 2 pembina sepenuh masa + 1 QA separuh masa + penyeliaan pemilik produk separuh masa, bagi setiap fasa. Kos ringgit/dolar TIDAK dinyatakan dalam dokumen ini dengan sengaja — kadar kakitangan/kontraktor hanya pemilik produk tahu; dokumen analisis tidak mengarang angka bajet. Anggaran orang-bulan di atas diterbitkan daripada skop deliverable setiap fasa, bukan daripada pengukuran pasukan sebenar.

### 9.2 Naratif

**Fasa 1** ialah fasa penentu. Segala-galanya bergantung pada dua keputusan: Cart server-side yang currency-pinned, dan Checkout Orchestrator yang merupakan SATU-SATUNYA laluan ke SO. Cadangan turutan dalaman: (i) skema Cart + Cart Item + API harga semula server-side; (ii) Reservation Hold dengan `held_pax` pada TGD dan pengemasan SUM gate (R3) — ini mesti serentak, jangan ship cart tanpa hold kerana overbooking gate sedia akan jadi tidak konsisten; (iii) orchestrator dengan strategy trip_package dahulu (membungkus `confirm_booking` sedia), kemudian merchandise (paling mudah: stok sedia, tiada slot); (iv) promo cart-level; (v) Saved Quote dan portal My Orders. Effort keseluruhan L, tetapi setiap minggu ada releasable increment di belakang feature flag. Hujung Fasa 1: selepas parity lulus dan diluluskan pemilik produk, wizard lama (state `sessionStorage`) dibersarakan — UI `/booknow` kekal sebagai pintu funnel trip di atas Cart API, bukan dua funnel selamanya (selari larangan §10.3).

**Fasa 2** membina di atas landasan itu: setiap produk baharu hanyalah strategy + skema + halaman — bukan saluran baharu. Flight sebagai produk jualan patut digunakan semula dari `Flight`/`Flight Schedule` sedia (fulfilment → jualan) dengan seat counter terhubung ke `max_seat`. Refund automation diletakkan di sini bukan Fasa 1 kerana ia perlu orchestrator stabil dahulu untuk mengelakkan dua laluan mutasi status. Wishlist turut di sini — selepas My Orders membuktikan corak portal baca-sahaja.

**Fasa 3** hanya bermakna apabila Fasa 2 membuktikan orchestrator tahu handle produk pelbagai bentuk. Marketplace dan API layer adalah risiko tertinggi (pengesahan identiti, rate limit, harga net) tetapi tidak menyentuh invariant: setiap order tetap melalui orchestrator.

---

## 10. Final Recommendation

### 10.1 Keputusan utama

1. **Kekal ERPNext SO/SI/PE sebagai backbone**; lapisan Commerce (Cart, Checkout Orchestrator, Promo Engine) dibina DALAM `travel_booking` — bukan app berasingan, kerana `on_sales_order_change` dan seluruh rantai doc events tidak boleh diputus.
2. **Checkout Orchestrator = satu-satunya pintu ke Sales Order**. Semua produk, semua saluran (web, portal, B2B, API masa depan) melaluinya. Ini mitigasi utama risiko R4.
3. **Invariant wang tidak dirundingkan**: SO kekal GROSS; semua diskaun (voucher cart-level, cashback, referral) masuk sebagai PE deductions ke akaun Marketing Expenses; price rule kekal NET per-produk best-only.
4. **Overbooking gate dikemas kini sekali sahaja** untuk memasukkan Reservation Hold (`held_pax` pada TGD, dalam transaksi sama dengan `FOR UPDATE` sedia) — jangan bina hold sebagai sistem selari.
5. **Cruise/departure kekal master domain** (Trip → TGD → Schedule); merchandise sahaja Item ERPNext. webshop kekal tidak dipasang.
6. **Satu mekanisme multi-domain sahaja**: kekalkan app `multi_domain_routing`, bersihkan mapping domain dari `Travel Website`/`index.py` secara berperingkat.
7. **Wizard `booknow.js` dimigrasi secara strangler fig**, bukan rewrite sekali harung; parity test (harga, deposit, OTP) ialah pintu keluar setiap tahap.
8. **Travel Inquiry kekal sebagai lead capture; Saved Quote (Quotation-based) menjadi hasil akhir boleh-ditukar** — dua peringkat funnel yang sama, bukan dua sistem bertindih.
9. **Satu currency per cart diterima sebagai constraint reka bentuk** Fasa 1–2 (selari dengan `resolve_so_currency_context` conversion_rate=1.0); tukar currency = cart baharu.

### 10.2 Langkah segera — 2 minggu pertama

| Hari | Tindakan |
|---|---|
| 1–2 | Tulis ADR ringkas untuk keputusan #1–#9 (satu halaman, luluskan dengan pemilik produk). Freeze skema: draf JSON DocType Cart, Cart Item, Reservation Hold (baharu). |
| 3–5 | Bina `cart.py` (baharu): create/read/update cart, re-price server-side guna semula `_get_pricing_map` + `get_public_merchandise`; unit test tanpa UI. |
| 5–7 | Ubah SUM overbooking gate + medan `held_pax` (TGD custom field) + expiry scheduler; **test race secara konkuren** (dua worker checkout serentak) sebelum merge. |
| 8–10 | Checkout Orchestrator fasa trip sahaja: bungkus `confirm_booking` sebagai strategy pertama; wizard lama tidak berubah (backend sama). |
| 11–14 | Parity harness: skrip ujian end-to-end wizard-lama vs cart (harga, deposit 5%, OTP; senarai penuh kriteria di 8.4-R2; go/no-go oleh pemilik produk), + perbaiki isu P1 audit GUI yang murah (typo copy "Price is varies base on"/"Gratitude fee"/"Pay at your way"/"Rarecattion Travel", navbar konsisten, penapis destinasi kosong, pilihan deposit eksplisit) serta **audit & pembetulan data harga per-currency SGD/MYR di sumber** (punca data, bukan kod — lihat §3.4) sebagai quick wins keyakinan. |

### 10.3 JANGAN buat ini (anti-pattern)

- **Jangan tulis diskaun pada baris/total SO** — pecah invariant SO-GROSS dan seluruh penyelesaian `_settle_order_discount_residue`.
- **Jangan cipta SO di luar Checkout Orchestrator** (termasuk skrip patch/debug) — setiap insert mencetus `on_sales_order_change` dan kesan sampingannya.
- **Jangan jadikan Trip/Cruise/TGD sebagai Item atau Item Variant** — model slot/allotment tidak terbentuk dalam Item ERPNext; ini keputusan yang sukar dibalikkan.
- **Jangan pasang webshop untuk "cart percuma"** — cart Quotation-nya bercanggah dengan backbone SO dan menambah permukaan penyelenggaraan.
- **Jangan bina dua laluan checkout selari melebihi tempoh migrasi** — setiap hari kedua-duanya hidup, risiko divergence harga/gate bertambah.
- **Jangan tampal FX conversion dalam cart** untuk "menyelesaikan" isu harga SGD tidak konsisten (audit GUI t16) — punca sebenar ialah data harga per-currency; betulkan di sumber (Catalog Query Layer memusatkan resolusi currency).
- **Jangan hapuskan `booknow.js` atau mekanisme domain lama sebelum pengganti lulus parity** — konsolidasi berperingkat, bukan pemusnahan.

---

## Lampiran A — Kedudukan arsitektur diluluskan pemilik produk

Senarai asal kelulusan pemilik produk, dilampirkan untuk rujukan silang. **Penomboran di bawah ialah penomboran senarai kelulusan ini — berbeza daripada senarai "Keputusan utama" §1.** Semua rujukan "kedudukan diluluskan #N" dalam badan dokumen merujuk senarai ini.

1. Kekal ERPNext SO/SI/PE sebagai backbone transaksi (terbukti + invariant sedia ada). Tambah lapisan Commerce dalam app travel_booking: Universal Cart + Checkout Orchestrator + Promo Engine peringkat cart.
2. Cruise/departure BUKAN Item/Item Variant — kekal master domain (Trip → TGD → Schedule). Merchandise sahaja guna Item (+ Item Variant untuk size/colour). Travel Package kekal Trip Package + BOM custom (BUKAN ERPNext Product Bundle).
3. Cart baharu: DocType Cart + Cart Item — persistent, cross-category (discriminator product_type: trip_package/addon_package/merchandise/flight/activity), params (tarikh, pax, kabin), currency-pinned dari geo axis, re-pricing server-side semasa checkout.
4. Checkout Orchestrator: generalisasi confirm_booking dengan modul strategi per product_type (validate → price → reserve/hold → baris SO → fulfilment). Invariant SO-GROSS/PE-deduction KEKAL pada Fasa 1.
5. Inventori: merchandise = stock ERPNext (sedia); cruise = cabin allotment + Cruise Cabin registry (sedia) + Reservation Hold berexpiry untuk cart; flight = seat counters (sambung Flight.max_seat); activity = qty caps → slot tarikh (Activity Schedule baharu); insurance/fee = tiada inventori.
6. Promo: Voucher diperluas ke cart-level merentas kategori; price rule kekal per-produk (best-only); peraturan stacking ditakrifkan.
7. webshop TIDAK diadopsi (model cart Item/simple-product + Quotation bercanggah dengan backbone SO; permukaan penyelenggaraan tambahan) — guna semula konsep sahaja.
8. Portal: My Bookings (sedia) + My Orders (merchandise) + My Travellers (direktori disatukan) + Payments/Documents (tingkat) + Wishlist + Saved Quotes (Quotation-based).
9. Roadmap: Fasa 1 = cart + checkout bersatu + promo cart + guest merch + saved quote + hold; Fasa 2 = slot aktiviti + hotel master + flight jualan + search/facets + refund automation + cukai/penghantaran + portal B2B; Fasa 3 = marketplace multi-supplier + API layer + corporate + loyalty/reviews.
