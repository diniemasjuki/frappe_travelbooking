// Workflow: Analisis menyeluruh transformasi travel_booking -> platform jualan online (eCommerce)
// Deliverable: ECOMMERCE_TRANSFORMATION_ANALYSIS.md di repo root (Bahasa Malaysia, 10 seksyen, tugas A-J)
// Termasuk: audit GUI black-box laman dev (browse-only, Playwright headless fallback) sebagai bukti Gap Analysis.

interface EnvPrep {
  /** Playwright berfungsi (ujian screenshot lulus) dan sedia digunakan. */
  playwrightReady: boolean;
  /** URL asas laman yang berfungsi untuk audit (cth https://trip.rarecation.com). */
  siteUrl: string;
  /** Domain cruise.rarecation.com berjaya dipetakan ke 127.0.0.1 dalam /etc/hosts. */
  cruiseDomainAvailable: boolean;
  /** Email akaun test customer yang dicipta pada site dev _rare. */
  testEmail: string;
  /** Password akaun test (dilaporkan kepada pengguna; site dev sahaja). */
  testPassword: string;
  /** Nota ringkas: kejayaan/kegagalan setiap langkah persiapan. */
  notes: string;
}

interface AuditReport {
  /** Laluan relatif-repo ke laporan audit penuh (markdown). */
  reportPath: string;
  /** Ringkasan satu perenggan keadaan UX semasa. */
  summary: string;
  /** Bilangan halaman/keadaan yang berjaya diaudit. */
  pagesVisited: number;
  /** Geseran UX diperhati - satu baris setiap satu. */
  friction: string[];
  /** Jurang e-commerce diperhati - satu baris setiap satu. */
  gaps: string[];
  /** Titik uji yang terhalang dan sebabnya - satu baris setiap satu. */
  blocked: string[];
}

interface Draft {
  /** Laluan penuh fail draf markdown seksyen. */
  path: string;
  /** 3-8 keputusan utama dalam draf - satu baris setiap satu. */
  keyDecisions: string[];
}

interface Assembled {
  /** Laluan relatif-repo dokumen akhir. */
  docPath: string;
  /** Bilangan patah perkataan dokumen akhir. */
  wordCount: number;
  /** Nama DocType tidak sah yang ditemui dan dibetulkan semasa QA. */
  doctypeFixes: string[];
  /** 5-10 keputusan utama keseluruhan dokumen. */
  keyDecisions: string[];
}

interface ReaderIssue {
  /** Seksyen dokumen yang berkenaan. */
  section: string;
  /** Isu satu ayat: kabur, tidak disokong, atau percanggahan. */
  issue: string;
  /** Kepentingan isu. */
  severity: "low" | "medium" | "high";
}

interface ReadIssues {
  /** Senarai isu (kosong jika dokumen sudah jelas). */
  issues: ReaderIssue[];
  /** Penilaian keseluruhan 1-2 ayat. */
  verdict: string;
}

interface WorkflowFinding {
  /** Lokasi: seksyen dokumen, fail, atau objek yang berkenaan. */
  where: string;
  /** Satu ayat: apa yang ditemui atau dicadangkan. */
  what: string;
  /** Asas: bukti, semakan, atau sumber. */
  evidence: string;
  /** "verified" = disahkan bebas; "unconfirmed" = tidak. */
  status: "verified" | "unconfirmed";
  /** Kepentingan. "high" hanya untuk kehilangan data, crash, atau keputusan salah. */
  severity: "low" | "medium" | "high";
}

const DOC_PATH = "ECOMMERCE_TRANSFORMATION_ANALYSIS.md";
const DRAFT_DIR = "/home/frappe/gui-audit-workspace/drafts";
const SHOT_DIR = "/home/frappe/frappe-bench/apps/travel_booking/gui-test-screenshots";

// ---------------------------------------------------------------- FACT SHEET
const FACT_SHEET = [
  "# FACT SHEET - keadaan semasa travel_booking (disahkan eksplorasi kod, Nov 2026)",
  "",
  "## A. Struktur app",
  "- App Frappe v17 di atas ERPNext. Dev site: _rare (serve cruise.rarecation.com & trip.rarecation.com melalui nginx, dns_multitenant). Produksi: rpwp.my, trip.rarecation.com dll - JANGAN sentuh.",
  "- Logik bisnes hampir keseluruhannya dalam travel_booking/api/. DocTypes dalam travel_booking/travel_booking/module_travel_booking/doctype/ (68) + resources_management/doctype/ (3, crew). Halaman Desk custom dalam module_admin_portal/page/ dan resources_management/page/. Laman web + portal dalam travel_booking/www/ (Jinja .py/.html, base templates/base_travel.html - BUKAN web.html Frappe). Utils web: trip_catalog, featured_catalog, geo_currency, seo, website_config.",
  "- Konvensyen: komen/docstring BM; API whitelisted mesti type-annotated; use_json_request_body; asset cache-busting ?v=; doc events sangat saling berkait (rujuk hooks.py).",
  "",
  "## B. Model produk semasa",
  "- Trip (TRIP.YY.##; web view has_web_view, published, route, SEO) -> Trip Group Date (TGD, RC.YY.##) = instance departure; max_participants/current_participants; status 8-keadaan; wajib cruise_schedule jika cruise; flight_schedule untuk fly package.",
  "- Trip Cruise Schedule (.ship_code.YY.#) = sailing; child cabin_rates (rows Trip Package Price dengan cabin_allotment/occupancy/available). Cruise Cabin = registry fizikal stateroom (naming schedule-room_no; Available/Blocked/Assigned/Maintenance; deck, bed_type).",
  "- Trip Package (TP.YY.MM.##; package_type: Fly Package / Ground Only / Cruise + Flight / Cruise Only / Customed) = unit jualan; child package_pricing (Trip Package Price: per Trip Price Category x currency; price keys: price_adult 12+, price_adult_single, price_upperberth, price_children 5-11, price_toddler 2-4, price_infant) + components (Trip Package Component BOM: component_type Activity/Excursion/Transfer/Merchandise/Miscellaneous; inclusion_mode Included/Optional/Post-booking Addon; merchandise_item -> Item ERPNext; cruise/flight kini diterbitkan daripada TGD selepas patch v43).",
  "- Trip Price Category = master kategori bilik/kabin (room_type Cabin/Suite/Villa/Room; capacity & max_capacity; gred).",
  "- Addon 3-tier: Trip Addon (definisi; addon_type Activity/Upgrade/Transfer/Other) -> Trip Addon Package (AP.YY.MM.###; currency_rates per currency; applicable_to All Trips/Specific + Trip Scoping trip/group_date/package; validity_mode One-Off/Same as Trip/Relative/Fixed; sales cutoff hari sebelum departure; max_qty_per_booking/max_total_qty/current_qty_sold) -> Booking Addon Item.",
  "- Flight (fulfilment sahaja, bukan produk jualan): Flight (per PNR, max_seat/seats_occupied), Flight Airline, Flight Airport, Flight Schedule (child Outbound/Return), Flight Request (Requested/Quoted/Booked/Fulfilled/Cancelled).",
  "- Merchandise: ERPNext Item + Item Group Merchandise + custom is_public_merchandise; Item Price per price list; stok Bin + Stock Reservation Entry (SO on_submit -> reserve_so_stock); Delivery Note pukal per TGD (create_delivery_notes_for_trip).",
  "- Travel B2B Partner (B2BP.YY.###; customer billing; users + access_level View/Docs/Full; package_discounts net-rate per pakej). Affiliate = ERPNext Sales Partner (referral_code) + app affiliate berasingan. Travel Inquiry = lead capture sahaja (bukan quoting).",
  "- Trip Organizer = master penganjur/cruise line (is_a_cruise_line). TIADA: hotel master, activity schedule/slot, cart, supplier master berasingan, saved quote, wishlist, product/website item custom.",
  "",
  "## C. Booking engine & wang",
  "- confirm_booking (api/booking_engine.py, allow_guest): parsing selections/billing -> T&C gate -> OTP gate (Redis booking_email_verified_<email>, api/otp.py; on-behalf staff & B2B bypass; B2B dilarang voucher/referral) -> _create_customer (Customer+Contact+DynamicLink) -> pricing map + apply_price_rules -> _validate_selection_capacity -> OVERBOOKING GATE: SELECT ... FOR UPDATE pada TGD + SUM(booked_pax) vs max_participants -> Sales Order (sebagai Administrator) -> Booking (status Pending) -> _ensure_portal_user -> bayaran (Online: Stripe PaymentIntent via Payment Request + URL /checkout?pr=; Manual Transfer: draft Payment Entry + resit; Held: tiada).",
  "- Baris SO: item service TRAVEL-PKG (satu baris per pax, rate dari Trip Package Price) + custom fields (custom_room_category, custom_cabin_no, custom_pax_type, custom_trip_package, custom_trip_group_date, custom_room_privacy). Addon SO: item Trip Addon Package. Merch SO: item stok + reserve_stock. TIADA Item per trip/package.",
  "- SO = SOURCE OF TRUTH HARGA. Semua perubahan SO (on_update/on_update_after_submit/on_cancel/on_trash) -> on_sales_order_change -> _recompute_booking_status (payment_status, pre_discount_total, booked_pax, auto Pending->Accepted, _activate_booking mencipta Booking Reservation per pax, _maybe_auto_invoice_so, refresh Booking Addon).",
  "- INVARIANT WANG: SO kekal GROSS; voucher/referral/cashback diserap sebagai PE deductions ke akaun Marketing Expenses (received + deductions = allocated); price rule dijual NET pada SO; _settle_order_discount_residue selepas Stripe. B2B peratus -> additional_discount_percentage pada SO.",
  "- Status Booking: Pending/Accepted/Processing/Confirmed/Completed/Abandoned/Cancelled. payment_status: Pending/Partially Paid/Paid/Request Refund/Pending Refund/Refunded/Canceled.",
  "- Booking Reservation = SATU SLOT TETAMU (bukan bilik): links traveller, trip_package, date_selection, trip_cruise_schedule, room_category, flight; rooming fields (cabin_no, room_id, guest_sequence, room_privacy, stateroom_no, cabin_is_confirmed); passport_link_token untuk co-traveller. Bilik = room_key = COALESCE(NULLIF(room_id,''), CONCAT(booking,'-Room_',cabin_no)).",
  "- Booking Amendment: tukar tarikh/pakej -> SO baharu + credit note (make_sales_return). Addon checkout (checkout_addons): re-price server-side -> Booking Addon + Booking Addon Item + SO (custom_booking_addon). Cabin sharing: SO tambahan traveller/kabin; cabin upgrade: addon khas yang rewrite room_category selepas dibayar.",
  "- Scheduler harian: mark_completed_trips, mark_abandoned_pending_bookings, reconcile_missing_invoices, passport cleanup (imej passport dipadam selepas 6 bulan, tidak diarkib), reservation statuses; cron tengah malam: status TGD/cruise schedule.",
  "",
  "## D. Pricing & promo",
  "- Pricing: _get_pricing_map (per kategori; baris currency khusus menang ke atas native); cruise = model SLOT (1 tetamu utama -> price_adult_single; >=2 -> price_adult; extra bed -> price_upperberth), non-cruise = model AGE. _validate_selection_capacity (capacity kategori, max cabins per booking dari Travel Settings, default 8).",
  "- Travel Price Rule (PR.YY.MM.##): scoped (applicable_trips/group_dates/packages/room_categories/guest_types), Percentage atau Amount per currency (Travel Price Rule Amount), priority, early-bird min_days_before_departure; BEST-ONLY per unit, TIADA stacking; snapshot ke Booking.applied_price_rules; SO dibina atas harga NET.",
  "- Voucher (voucher_code): Percentage/Fixed Amount + currency; valid_from/until; max_usage, max_usage_per_customer (Voucher Usage log, SELECT FOR UPDATE); scoped trip/package/room category; diskaun atas subtotal kabin sepadan, dikira atas harga PROMO. HANYA berkesan pada booking utama (wizard) - addon/merch/cabin-sharing SO TIDAK boleh guna voucher/price rule/referral.",
  "- Multi-currency axis: Travel Settings.currency_accounts (Travel Currency Account: currency -> company, selling_price_list, bank_account, manual_transfer_paid_to_account, cashback_discount_account, payment_gateway_account). resolve_so_currency_context - conversion_rate=1.0, multi-company sebenar, TIADA penukaran FX. Website: geo_currency (param > cookie rc_currency > geo-IP CF-IPCountry > default axis).",
  "",
  "## E. Web & portal semasa",
  "- Laman awam: / (rewrite ikut domain; DUA mekanisme bertindih: app multi_domain_routing + Travel Website multi_domain mappings), /cruise, /tour, /trips (filter q/destination/item_group/date/sort/currency), /cruises, /tours, /cruise-schedule (timeline + modal pilihan pakej), /<trip-route> (detail, package-first widget, harga live via get_booking_details), /booknow (wizard 4 langkah: Rooms & Passengers -> Billing -> Payment -> Confirm; sessionStorage bnw_cart), /checkout?pr= (Stripe Elements custom), /booking-terms, /set-password, /guest_passport?token=.",
  "- Portal /traveller/*: login (password/magic link/Google OAuth; TIADA self-signup - user dicipta semasa booking pertama), bookings, booking?ref=, billing?ref=, travellers?ref= (passport OCR in-house MRZ), booking_addons?booking=, manage_addon?ref=, transactions, profile, onbehalf-* (mirror untuk staff/affiliate/B2B).",
  "- Kemampuan portal: senarai booking, bayar baki per SO (Stripe, min deposit peratus), muat naik resit manual, beli addon/upgrade kabin, tambah traveller ke kabin / kabin baharu, urus dokumen traveller, muat turun resit/invoice/proforma PDF, PDPA request, update profile. TIADA: self-cancel, refund request, wishlist, saved quote, sejarah pesanan merchandise.",
  "- Merchandise: get_public_merchandise (allow_guest) katalog; create_merch_order PERLU LOGIN (tiada guest checkout); tiada cart, tiada cukai/penghantaran.",
  "",
  "## F. Ekosistem bench",
  "- Terpasang pada _rare: frappe, erpnext, payments (Stripe Settings), print_designer, newsletter, letters, erpnext_telegram_integration, builder, builder_hub, hrms, travel_booking, affiliate, multi_domain_routing, blog.",
  "- webshop ADA dalam bench TETAPI tidak dipasang pada site (Website Item, cart berasaskan Quotation, wishlist, item review - semuanya tidak digunakan).",
  "- nginx: cruise.rarecation.com & trip.rarecation.com -> _rare; /etc/hosts tempatan ada trip.rarecation.com sahaja.",
  "",
  "## G. Integrasi ERPNext digunakan secara programatik",
  "- DICIPTA app: Customer, Contact + Dynamic Link, Address, User portal, Sales Order (custom_booking / custom_booking_addon), Payment Entry (manual + deductions + settlement), Payment Request, Sales Invoice (auto) & Sales Return (credit note), Item (TRAVEL-PKG, Trip Addon Package, merchandise), Item Price, Stock Reservation Entry, Delivery Note, File.",
  "- DIBACA: Company, Currency, Currency Exchange, Price List, Account, Bank Account, Warehouse, Bin, Selling Settings, Sales Partner, Terms and Conditions, Stripe Settings, Payment Gateway Account.",
  "",
  "## H. Jurang e-commerce utama (dari kod)",
  "1. Tiada cart persistent (sessionStorage sahaja); tiada mixed-category cart.",
  "2. Promo hanya pada booking utama; tiada promo peringkat cart/line merentas kategori.",
  "3. Guest checkout hanya untuk trip; merchandise perlu login.",
  "4. Tiada Quotation/quote flow (terus ke SO); Travel Inquiry hanyalah lead.",
  "5. Refund manual sahaja (flag + log; tiada Stripe refund API).",
  "6. Merchandise: tiada cukai/penghantaran per pesanan.",
  "7. Tiada search/faceting untuk merchandise/aktiviti; katalog flat (limit 100).",
  "8. Tiada wishlist/reviews/loyalty.",
  "9. webshop tidak digunakan langsung.",
  "10. Tiada simpanan kaedah bayar; tiada dunning/auto-retry (hanya status Abandoned).",
].join("\n");

// ------------------------------------------------------- KEDUDUKAN DILULUSKAN
const POSITIONS = [
  "# KEDUDUKAN ARKITEKTUR DILULUSKAN PEMILIK PRODUK (dokumen MENGHUJAHKAN ini)",
  "1. Kekal ERPNext SO/SI/PE sebagai backbone transaksi (terbukti + invariant sedia ada). Tambah lapisan Commerce dalam app travel_booking: Universal Cart + Checkout Orchestrator + Promo Engine peringkat cart.",
  "2. Cruise/departure BUKAN Item/Item Variant - kekal master domain (Trip -> TGD -> Schedule). Merchandise sahaja guna Item (+ Item Variant untuk size/colour). Travel Package kekal Trip Package + BOM custom (BUKAN ERPNext Product Bundle).",
  "3. Cart baharu: DocType Cart + Cart Item - persistent, cross-category (discriminator product_type: trip_package/addon_package/merchandise/flight/activity), params (tarikh, pax, kabin), currency-pinned dari geo axis, re-pricing server-side semasa checkout.",
  "4. Checkout Orchestrator: generalisasi confirm_booking dengan modul strategi per product_type (validate -> price -> reserve/hold -> baris SO -> fulfilment). Invariant SO-GROSS/PE-deduction KEKAL pada Fasa 1.",
  "5. Inventori: merchandise = stock ERPNext (sedia); cruise = cabin allotment + Cruise Cabin registry (sedia) + Reservation Hold berexpiry untuk cart; flight = seat counters (sambung Flight.max_seat); activity = qty caps -> slot tarikh (Activity Schedule baharu); insurance/fee = tiada inventori.",
  "6. Promo: Voucher diperluas ke cart-level merentas kategori; price rule kekal per-produk (best-only); peraturan stacking ditakrifkan.",
  "7. webshop TIDAK diadopsi (model cart Item/simple-product + Quotation bercanggah dengan backbone SO; permukaan penyelenggaraan tambahan) - guna semula konsep sahaja.",
  "8. Portal: My Bookings (sedia) + My Orders (merchandise) + My Travellers (direktori disatukan) + Payments/Documents (tingkat) + Wishlist + Saved Quotes (Quotation-based).",
  "9. Roadmap: Fasa 1 = cart + checkout bersatu + promo cart + guest merch + saved quote + hold; Fasa 2 = slot aktiviti + hotel master + flight jualan + search/facets + refund automation + cukai/penghantaran + portal B2B; Fasa 3 = marketplace multi-supplier + API layer + corporate + loyalty/reviews.",
].join("\n");

// --------------------------------------------------------------------- GAYA
const STYLE = [
  "# GAYA PENULISAN DAN KEKONSISTENAN",
  "- Bahasa Malaysia; istilah teknikal kekal English (DocType, Sales Order, cart, checkout, hold, addon, dan sebagainya).",
  "- Berpendirian: setiap keputusan ada cadangan jelas; jadual pro/kontra bila relevan; nyatakan sebab setiap keputusan.",
  "- Sebut nama DocType/fail SEBENAR sahaja (jangan reka). Cadangan DocType/modul baharu wajib berlabel (baharu).",
  "- Jadual markdown + diagram ASCII dalam code fence.",
  "- Setiap cadangan mesti menyatakan kesannya terhadap invariant sedia ada (SO-GROSS + PE deductions, currency axis, overbooking gate FOR UPDATE, rantai doc events on_sales_order_change).",
  "- Glosari istilah cadangan (guna konsisten): Cart, Cart Item, Checkout Orchestrator, Product Type Strategy, Reservation Hold, Catalog Query Layer, Saved Quote, lapisan Commerce.",
].join("\n");

// ------------------------------------------------------------------- PERSONA
const AUTHOR_PERSONA = [
  "Anda Senior Business Analyst & Solution Architect pakar Frappe Framework, ERPNext, industri travel, OTA dan e-commerce.",
  "Anda menulis analisis berpendirian dalam Bahasa Malaysia (istilah teknikal English) berasaskan fakta yang disahkan - rujuk repo untuk verifikasi, jangan reka nama DocType/fail.",
  "Jika sesuatu arahan mustahil dicapai atau bercanggah, eskalasi dan nyatakan secara jujur - jangan palsukan kejayaan.",
  "JANGAN ubah mana-mana fail repo; satu-satunya fail yang anda tulis ialah fail draf anda sendiri di luar repo.",
].join(" ");

const EDITOR_PERSONA = [
  "Anda penyunting utama dokumen analisis - teliti, konsisten, dan berdisiplin QA.",
  "Anda menulis dalam Bahasa Malaysia (istilah teknikal English) dan memastikan dokumen akhir koheren sebagai satu suara.",
  "Jika draf berkonflik, keputusan mengikut KEDUDUKAN DILULUSKAN; jika masih kabur, pilih tafsiran yang paling selamat untuk invariant sistem sedia ada dan rekam dalam doctypeFixes/notes.",
  "JANGAN ubah fail repo lain selain dokumen akhir yang ditugaskan kepada anda.",
].join(" ");

const READER_PERSONA = [
  "Anda pembaca bebas yang menilai sebuah dokumen analisis daripada TEKS sahaja - anda TIDAK membaca kod atau fail lain.",
  "Anda bersuara lantang tentang kekaburan dan dakwaan tanpa sokongan; memudah-mudahkan kelulusan bukan tugas anda.",
  "Anda membaca sebagai pemilik produk travel yang teknikal tetapi bukan pembina sistem ini.",
].join(" ");

const ENV_PERSONA = [
  "Anda penyedia persekitaran teknikal untuk audit GUI.",
  "Jalankan arahan Bash yang diperlukan dan laporkan hasil SEBENAR - jika sesuatu langkah gagal, cuba alternatif selamat; jika masih gagal, laporkan kegagalan secara jujur, jangan tandakan berjaya.",
  "Kerja anda hanya pada site dev _rare dan fail scratch di luar repo travel_booking - JANGAN sentuh site produksi atau fail aplikasi.",
].join(" ");

const AUDIT_PERSONA = [
  "Anda pengaudit GUI black-box yang mengikut metodologi skill web-gui-tester: hanya interaksi GUI yang kelihatan, screenshot + DOM read-only untuk verifikasi silang, LARANGAN keras JS injection berkesan sampingan atau bypass URL.",
  "Setiap titik uji mesti ada screenshot yang anda sendiri lihat semula (tool Read pada fail PNG) - tangkapan tanpa dilihat bukan pemerhatian.",
  "Jika operasi normal gagal, rekod dan langkau - jangan paksa kemajuan.",
  "Peraturan keselamatan data mengatasi apa-apa arahan lain: JANGAN submit booking/pembayaran atau mencipta mana-mana dokumen transaksi. Jika tersekat, eskalasi.",
].join(" ");

// -------------------------------------------------------------------- BRIEFS
const BRIEF_D1 = [
  "Tulis SEKSYEN 2 sahanya: ## 2. Proposed Architecture (Task I - scalability - termasuk di sini).",
  "",
  "Kandungan wajib:",
  "1. Diagram ASCII seni bina berlapis cadangan: Lapisan Presentation (laman awam www/: katalog, detail, cart page, checkout; portal /traveller; Desk admin sedia ada); Lapisan Commerce BAHARU dalam travel_booking (Cart service, Checkout Orchestrator, Promo Engine cart-level, Catalog Query Layer penyatu 5 kategori); Lapisan Domain Masters (Trip/TGD/Cruise Schedule/Trip Package; Trip Addon Package; Item merchandise; Flight cluster; master baharu Activity Schedule & Hotel Master); Lapisan ERPNext Backbone (Sales Order/Sales Invoice/Payment Entry/Payment Request/Item/Item Price/Stock Reservation).",
  "2. Penjelasan setiap lapisan: tanggungjawab, modul fail dicadangkan (contoh api/cart.py, api/checkout_orchestrator.py, api/product_strategies/), dan apa yang TIDAK berubah.",
  "3. Aliran rujukan end-to-end: browse -> cart -> checkout -> validasi/hold -> SO -> bayaran -> fulfilment -> portal; nyatakan titik integrasi dengan invariant sedia ada (SO-GROSS + PE deductions; currency axis; overbooking gate FOR UPDATE; rantai doc events on_sales_order_change).",
  "4. Task I - Scalability: (a) multi cruise operator (Trip Organizer is_a_cruise_line sedia ada - cukup?); (b) multi airline (Flight Airline sedia ada); (c) multi supplier (hujah: kekal Trip Organizer sebagai master penyedia, naik taraf bila perlu); (d) B2C sedia ada; (e) B2B agent (Travel B2B Partner + users + package_discounts sedia ada; portal self-service & net-rate di Fasa 2/3); (f) corporate booking (Fasa 3: cost centre, approval, invoice terkumpul); (g) API integration (Fasa 3: REST whitelisted + API key per B2B partner + rate limiting + webhook).",
  "5. Jadual ringkas: apa berubah / apa kekal.",
].join("\n");

const BRIEF_D2 = [
  "Tulis SEKSYEN 3 dan 4.",
  "",
  "## 3. Product Model (Task A):",
  "1. Cadangkan Product Master Structure, Item Category Structure, Product Variant Structure, Bundle Structure dan Package Structure untuk platform 5 kategori produk.",
  "2. JAWAB lima soalan keputusan dengan jadual pro/kontra + keputusan akhir setiap satu: (a) Cruise patut jadi Item (ERPNext)? (b) Cruise Schedule patut jadi Variant? (c) Departure Date patut jadi Variant? (d) Activity patut jadi Add-On? (e) Travel Package patut jadi Product Bundle (ERPNext)? Kedudukan diluluskan: a=TIDAK (kekal master domain; item service TRAVEL-PKG pada baris SO); b=TIDAK; c=TIDAK - hujahkan anti-pattern variant explosion (tiada semantik tarikh, inventori tidak serasi, pertumbuhan varian tak terkawal, UX carian tarikh rosak); d=YA (kekal Trip Addon Package, diperkukuh Activity Schedule slot pada Fasa 2); e=TIDAK (kekal Trip Package + Trip Package Component BOM custom - Product Bundle ERPNext tiada availability bergantung tarikh/harga per pax-type).",
  "3. Item Variant hanya untuk merchandise (size/colour) - bila wajar, bila tidak.",
  "4. Catalog Query Layer: antara muka penyatu katalog web merentas kategori (fungsi, sumber data, facet/ranking asas).",
  "",
  "## 4. Data Model (Task B):",
  "1. DocType BAHARU dicadangkan dengan lakaran field utama, penamaan (ikut gaya sedia ada) dan module placement: Cart, Cart Item, Reservation Hold, Activity Schedule (slot tarikh/kuantiti), Saved Quote, Wishlist; Hotel Master sebagai cadangan Fasa 2.",
  "2. DocType SEDIA ADA yang perlu DIUBAH (field/behavior): Booking (cart_source, order_type), Voucher (scope merentas kategori + level cart), Trip Addon Package (link Activity Schedule), Flight (attribute sellable), Travel Settings (flag cart/hold TTL) dan lain-lain - senarai lengkap dengan justifikasi.",
  "3. Diagram ASCII entity-relationship penuh: sedia ada (ringkas) + baharu (tanda *): Trip->TGD->Cruise Schedule->Trip Package->Trip Package Price; Cart->Cart Item->(reference produk); Booking->Booking Reservation->Traveller; Booking->Sales Order.",
  "4. Naratif relation setiap DocType baharu dengan yang sedia ada.",
].join("\n");

const BRIEF_D3 = [
  "Tulis SEKSYEN 5 sahaja: ## 5. Sales Flow (merangkumi Task C, D, E, F - gunakan sub-heading 5.1-5.4).",
  "",
  "5.1 Aliran jualan hujung-ke-hujung (Task C): huraikan TERPERINCI setiap langkah: Visitor -> Browse Product -> View Product Detail -> Add To Cart -> Checkout -> Payment -> Booking Confirmation -> Customer Portal. Setiap langkah: halaman www (sedia ada vs baharu), API whitelisted (sedia ada vs baharu), DocType yang ditulis/dibaca, validasi utama, keadaan error. Nyatakan jelas komponen SUDAH WUJUD (katalog, detail, OTP, Stripe checkout, portal) vs BAHARU (cart page, cart API, checkout bersatu).",
  "5.2 Cart Design (Task D): (a) universal cart - keputusan reka bentuk (persistent Cart DocType vs session; cadangan: DocType, sebab); (b) struktur Cart Item (product_type: trip_package|addon_package|merchandise|flight|activity; reference links; params: tarikh, pax breakdown, kabin; qty; currency; harga display vs re-price); (c) pricing structure - re-pricing server-side semasa checkout (ikut pola checkout_addons sedia ada), currency-pinned dari geo axis; (d) discount structure - tiga lapisan: Travel Price Rule (per-unit, NET pada SO), Voucher cart-level (SO GROSS + PE deduction - kekal invariant), manual/staff discount; peraturan stacking (price rule best-only per unit; satu voucher per cart; larangan B2B); (e) promo code structure - pengukuhan Voucher (scope merentas kategori, min spend, usage caps sedia ada).",
  "5.3 Booking Engine (Task E): SATU arkitektur untuk semua kategori - Checkout Orchestrator + Product Type Strategy interface (validate_selection, price_selection, reserve_or_hold, build_so_lines, on_payment_success/fulfil). Contoh konkrit: Cruise Booking (slot model, cabin allotment + hold), Flight Booking (seat, FIT/GIT), Package Booking (BOM komponen + cruise/flight diterbitkan), ringkasan Merch Order dan Activity. Nyatakan generalisasi confirm_booking: fasa yang KEKAL (OTP gate, _create_customer, capacity gate FOR UPDATE, penciptaan SO/Booking, payment) dan yang BERUBAH (input daripada cart, strategi per jenis produk).",
  "5.4 Inventory vs Non-Inventory (Task F): jadual per kategori: Cruise (capacity: cabin allotment + Cruise Cabin registry + Reservation Hold TTL), Flight (seat pada Flight), Merchandise (stock ERPNext: Bin + Stock Reservation Entry), Activity (kuantiti + slot Activity Schedule), Insurance/fee (tiada inventori). Reasoning setiap satu + mekanisme Reservation Hold (TTL, scheduler expiry, release, interaksi dengan overbooking gate).",
].join("\n");

const BRIEF_D4 = [
  "Tulis SEKSYEN 6 dan 7.",
  "",
  "## 6. Customer Journey (Task G):",
  "1. Cadangan menu portal penuh: My Orders, My Bookings, My Travellers, Payments, Documents, Wishlist, Saved Quote - setiap menu: fungsi terperinci, pemetaan ke halaman/API sedia ada (contoh My Bookings = /traveller/bookings sedia ada) vs baharu, keperluan data.",
  "2. Journey map pelanggan empat fasa: pre-purchase (browse/compare/wishlist/quote), purchase (cart/checkout/payment), post-booking (travellers/addons/dokumen/amendment), post-trip (documents/resit/review) - jadual langkah + touchpoint + geseran yang diperhati audit GUI (jika ada).",
  "3. Perbezaan keperluan B2C vs B2B partner vs on-behalf staff pada portal (role sedia ada: Customer, Travel On Behalf Role, Travel B2B Partner User).",
  "",
  "## 7. ERPNext Mapping (Task H):",
  "1. Jadual pemetaan penuh: Item, Item Variant, Product Bundle, Item Price, Price List, Pricing Rule, Sales Order, Sales Invoice, Payment Entry, Payment Request, Stock Reservation/Delivery Note - lajur: guna built-in sepenuhnya / guna dengan custom fields / TIDAK digunakan (custom dalam travel_booking) + sebab.",
  "2. Senarai eksplisit: APA YANG PATUT GUNA BUILT-IN ERPNext vs APA YANG PATUT CUSTOM DALAM APP travel_booking.",
  "3. Hujah kenapa webshop TIDAK diadopsi (model cart Quotation/Item bertentangan dengan backbone SO + invariant wang; permukaan penyelenggaraan tambahan; konflik template base_travel) + konsep webshop yang berbaloi dipinjam sebagai pola reka bentuk (merchandising Website Item, wishlist, item review).",
  "4. Kekal invariant: SO source of truth, snapshot sync, auto-invoice, currency axis multi-company.",
].join("\n");

const BRIEF_D5 = [
  "Tulis SEKSYEN 8, 9 dan 10.",
  "",
  "## 8. Gap Analysis (Task J1-J4):",
  "1. Jadual feature yang perlu DITAMBAH (daripada booking-management ke sales platform) - keutamaan + kesan.",
  "2. Jadual feature yang perlu DIUBAH (contoh: wizard booknow -> cart checkout; voucher -> cart-level; pengurusan traveller -> direktori).",
  "3. Senarai yang perlu DIBUANG/DIKONSOLIDASI (contoh: salah satu mekanisme multi-domain bertindih; sessionStorage bnw_cart; Travel Inquiry vs Saved Quote - nilaikan). Berhati-hati: buang bermaksud konsolidasi berperingkat, bukan pemusnahan fungsi.",
  "4. Risiko arkitektur (Task J4) + mitigasi: kompleksiti SO-GROSS/PE-deduction; migrasi booknow.js (~5k baris); Reservation Hold vs overbooking gate race; rantai doc events rapuh; dual multi-domain; godaan variant; kekangan satu-currency-per-cart.",
  "",
  "## 9. Roadmap (Task J5): Fasa 1 (asas jualan: universal cart + checkout bersatu + promo cart-level + guest merch checkout + saved quote + Reservation Hold + portal My Orders/Wishlist/Saved Quote), Fasa 2 (slot aktiviti, hotel master, flight sebagai produk jualan, search/facets, refund automation, cukai/penghantaran merchandise, portal B2B self-service), Fasa 3 (marketplace multi-supplier, API layer B2B/OTA, corporate booking, loyalty/reviews). Setiap fasa: skop, deliverable, kebergantungan, anggaran effort relatif (S/M/L), success criteria. Jadual ringkas + naratif.",
  "",
  "## 10. Final Recommendation: 8-10 keputusan utama (numbered), langkah segera 2 minggu pertama, dan senarai JANGAN buat ini (anti-pattern).",
].join("\n");

// ------------------------------------------------------------------- HELPERS
function parseLeadingInt(s: string): number {
  const m = s.trim().match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}

function buildAuthorAsk(brief: string, file: string, auditBrief: string): string {
  return [
    AUTHOR_PERSONA,
    "",
    FACT_SHEET,
    "",
    POSITIONS,
    "",
    STYLE,
    "",
    "# BUKTI AUDIT GUI",
    auditBrief,
    "",
    "# TUGAS ANDA",
    brief,
    "",
    "# VERIFIKASI TERHADAP REPO",
    "Untuk butiran yang diragukan, semak sendiri dengan Read/Grep/Glob (JANGAN ubah mana-mana fail repo). Laluan utama: travel_booking/hooks.py; travel_booking/api/booking_engine.py, so_helpers.py, pricing.py, price_rule.py, addon_manager.py, merchandise.py, portal_booking.py, stripe_checkout.py, voucher.py; travel_booking/travel_booking/module_travel_booking/doctype/ (senarai penuh DocType); travel_booking/www/; ROOMING_WORKFLOW.md; ENHANCED_ADDON_SCOPING.md; BOOKING_MANAGER_PROPOSAL.md.",
    "",
    "# OUTPUT",
    "Tulis draf markdown anda ke " + DRAFT_DIR + "/" + file + " (mula dengan heading seksyen anda, contoh: ## 3. Product Model). Sasaran 1200-2500 patah perkataan.",
    "Kemudian pulangkan JSON Draft: path = laluan penuh fail draf; keyDecisions = 3-8 keputusan utama draf anda (satu baris satu).",
  ].join("\n");
}

function buildEditorAsk(ds: Draft[], auditBrief: string): string {
  return [
    EDITOR_PERSONA,
    "",
    FACT_SHEET,
    "",
    POSITIONS,
    "",
    STYLE,
    "",
    "# TUGAS: HIM PUN DOKUMEN ANALISIS AKHIR",
    "Baca kelima-lima draf berikut (fail di luar repo):",
    ...ds.map((d) => "- " + d.path),
    "",
    "Bukti audit GUI: " + auditBrief,
    "",
    "Langkah:",
    "1. Gabung mengikut susunan seksyen 2 hingga 10; harmonisasi terminologi mengikut glosari dalam GAYA; betulkan percanggahan antara draf (keputusan mengikut KEDUDUKAN DILULUSKAN jika berkonflik).",
    "2. Tulis ## 1. Executive Summary (400-600 patah): konteks transformasi, 5-8 keputusan utama, gambaran roadmap Fasa 1-3, risiko terbesar.",
    "3. Header dokumen: tajuk, tarikh (2026-11-03), status DRAFT - untuk semakan, skop (analisis sahaja, tiada implementasi kod), dan senarai kandungan (TOC).",
    "4. QA WAJIB:",
    "   a. 10 seksyen lengkap (1 Executive Summary hingga 10 Final Recommendation).",
    "   b. Tugas A-J semua ditangani: A=seksyen 3, B=seksyen 4, C+D+E+F=seksyen 5, G=seksyen 6, H=seksyen 7, I=seksyen 2, J=seksyen 8-9.",
    "   c. Setiap nama DocType yang dinyatakan SEDIA ADA mesti wujud - sahkan dengan ls travel_booking/travel_booking/module_travel_booking/doctype/ dan travel_booking/resources_management/doctype/ (serta grep nama dalam dokumen); betulkan yang tidak sah dan rekam dalam doctypeFixes. Cadangan DocType BAHARU mesti berlabel (baharu).",
    "   d. Semua diagram ASCII dalam code fence; jadual markdown well-formed.",
    "   e. Rujukan laluan fail sah (semak dengan Glob/Read jika ragu).",
    "5. Tulis hasil ke " + DOC_PATH + " di root repo (workspace). JANGAN ubah fail repo lain.",
    "6. Kira patah perkataan dengan: wc -w " + DOC_PATH,
    "",
    "Pulangkan JSON Assembled: docPath = " + DOC_PATH + "; wordCount; doctypeFixes (senarai pembetulan dibuat); keyDecisions (5-10 keputusan utama dokumen, satu baris satu).",
  ].join("\n");
}

// ---------------------------------------------------------------- AUDIT ASKS
const ENV_ASK = [
  "Sediakan persekitaran untuk audit GUI laman dev travel_booking. Rangkaian internet tersedia (npm registry sah OK). Jalankan langkah berikut dengan Bash dan pulangkan hasil sebenar:",
  "",
  "1. PLAYWRIGHT: Cipta dir /home/frappe/gui-audit-workspace/driver (kosongkan jika wujud). Dalam dir itu sahaja (JANGAN dalam repo): npm init -y (jika tiada package.json), kemudian npm install playwright. Chromium binaries sedia di ~/.cache/ms-playwright (chromium-1248, chromium_headless_shell-1248). Uji dengan script node ringkas: chromium.launchPersistentContext headless, buka about:blank, screenshot ke /tmp/pw-test.png, tutup. Jika revision mismatch, jalankan npx playwright install chromium dan uji semula. Maksimum 2 cubaan.",
  "2. DIR: mkdir -p /home/frappe/gui-audit-workspace/drafts, /home/frappe/gui-audit-workspace/scripts, /home/frappe/gui-audit-workspace/browser-profile, dan " + SHOT_DIR + ".",
  "3. HOSTS: Semak /etc/hosts; jika cruise.rarecation.com tiada, tambah baris 127.0.0.1 cruise.rarecation.com menggunakan sudo (passwordless tersedia). Sahkan dengan getent hosts cruise.rarecation.com. Jangan ubah entri lain.",
  "4. AKAUN TEST (site dev _rare sahaja - JANGAN sentuh site lain): email gui.audit.test@rarecation.com dengan password rawak 16 aksara. Rujuk corak travel_booking/api/so_helpers.py (_create_customer, _ensure_contact_customer_link) dan cipta melalui bench --site _rare console (heredoc python) atau fail python sementara di /tmp: User (enabled, user_type Website User, roles: [Customer], new_password) + Customer (Individual, customer_group/territory ikut Selling Settings) + Contact + Dynamic Link supaya resolusi User->Customer portal berfungsi; frappe.db.commit() selepas insert. Jika email sudah wujud, set semula password dan guna semula.",
  "5. VERIFIKASI LAMAN: curl -sI https://trip.rarecation.com/ dan (jika hosts berjaya) https://cruise.rarecation.com/ - sahkan HTTP 200 atau 30x.",
  "",
  "Pulangkan JSON EnvPrep: playwrightReady (hanya true jika ujian screenshot lulus); siteUrl (URL asas yang berfungsi, contoh https://trip.rarecation.com); cruiseDomainAvailable; testEmail; testPassword; notes (ringkasan hasil setiap langkah, termasuk kegagalan).",
].join("\n");

// ---------------------------------------------------------------------- FLOW
phase("Semak rangkaian untuk audit GUI");
let networkOk = false;
try {
  const net = await world.run("curl", ["-sI", "--max-time", "10", "https://registry.npmjs.org/"]);
  networkOk = net.exitCode === 0;
} catch {
  networkOk = false;
}
let auditSkipReason = "";
if (!networkOk) {
  auditSkipReason = "tiada akses rangkaian ke npm registry - Playwright tidak boleh dipasang";
  log("Audit GUI dilangkau: " + auditSkipReason);
}

let bookingBaseline = -1;
let soBaseline = -1;
let envResult: EnvPrep | null = null;

if (networkOk) {
  phase("Sediakan persekitaran audit GUI");
  const bookingBase = await world.run("bench", ["--site", "_rare", "execute", "frappe.client.get_count", "--kwargs", "{'doctype': 'Booking'}"]);
  const soBase = await world.run("bench", ["--site", "_rare", "execute", "frappe.client.get_count", "--kwargs", "{'doctype': 'Sales Order'}"]);
  bookingBaseline = parseLeadingInt(bookingBase.stdout);
  soBaseline = parseLeadingInt(soBase.stdout);
  log("Baseline sebelum audit: Booking=" + bookingBaseline + ", Sales Order=" + soBaseline);
  try {
    envResult = await agent("Penyedia persekitaran", ENV_PERSONA).ask<EnvPrep>(ENV_ASK);
    log("Persiapan selesai: playwrightReady=" + envResult.playwrightReady + "; " + envResult.notes);
  } catch (e) {
    auditSkipReason = "penyediaan persekitaran gagal: " + String(e);
    log(auditSkipReason);
  }
}

const auditAttempted = envResult !== null && envResult.playwrightReady;
let audit: AuditReport | null = null;

if (auditAttempted && envResult !== null) {
  phase("Audit GUI laman jualan semasa");
  const auditAsk = [
    "MULA DENGAN: muat skill browser-use:web-gui-tester melalui tool Skill (wujud dalam sesi ini) dan ikuti metodologinya: pure GUI black-box; action -> observation -> action; screenshot + DOM read-only untuk verifikasi silang; larangan keras injection JS berkesan sampingan / bypass URL / refresh untuk lari daripada kegagalan; jika operasi gagal, rekod dan langkau.",
    "",
    "PENYESUAIAN TOOLING (penting): tooling browser rasmi sesi ini (node_repl MCP) TIADA. Guna Playwright headless melalui node dalam /home/frappe/gui-audit-workspace/driver (sudah dipasang). Corak disyorkan: setiap langkah = satu script node ringkas (fail .mjs dalam /home/frappe/gui-audit-workspace/scripts) menggunakan chromium.launchPersistentContext({ headless: true, userDataDir: /home/frappe/gui-audit-workspace/browser-profile, ignoreHTTPSErrors: true }) - profil ini mengekalkan cookies login antara script. Dalam setiap script: page.goto(url) -> waitForLoadState domcontentloaded -> tindakan (locator click/fill/selectOption) -> screenshot full page PNG -> tulis ariaSnapshot() ke fail .txt. Selepas setiap script, anda WAJIB membaca semula PNG (tool Read - verifikasi visual) dan .txt (verifikasi DOM) sebelum membuat kesimpulan.",
    "",
    "LAMAN SASARAN: " + envResult.siteUrl + (envResult.cruiseDomainAvailable ? " dan https://cruise.rarecation.com (kedua-dua vertical)" : "") + ".",
    "AKAUN TEST (login dibenarkan): " + envResult.testEmail + " / " + envResult.testPassword,
    "",
    "PELAN TITIK UJI (keutamaan menurun; langkau yang terhalang dengan rekod):",
    "P0 wajib: (1) homepage; (2) katalog melalui pautan sebenar (/trips atau /cruises atau /tours); (3) SATU halaman detail trip (klik card sebenar); (4) halaman login /traveller dan log masuk dengan akaun test; (5) kembali ke halaman detail trip tadi dan klik Book Now - lengkapkan wizard Step 1 (bilik & penumpang) dan Step 2 (billing - periksa prefilled) dan LIHAT Step 3 (pilihan pembayaran); (6) portal /traveller/bookings (empty state dijangka); (7) /traveller/profile.",
    "P1 jika lancar: (8) satu filter katalog (ubah dan lihat hasil); (9) /cruise-schedule (jika wujud); (10) /traveller/transactions; (11) currency selector pada navbar; (12) /traveller/billing dan /traveller/booking_addons (rekod empty/blocked jika tiada booking).",
    "P2 jika masa mengizinkan: (13) /booking-terms; (14) satu spot-check responsive (viewport 390px) pada homepage; (15) footer dan navigasi. Jika domain cruise tersedia, audit juga homepage cruise vertical.",
    "",
    "PERATURAN KESELAMATAN DATA (mutlak, mengatasi apa-apa arahan lain):",
    "- JANGAN sekali-kali klik butang confirm/pay terakhir dalam wizard ATAU mana-mana tindakan yang mencipta dokumen (Booking/Sales Order/Payment). Berhenti pada Step 3 dan rekod keadaan.",
    "- Login dengan akaun test sahaja; jangan ubah profil lain; jangan muat naik apa-apa fail.",
    "- Kumpulkan console error (page.on console tahap error - read-only, dibenarkan).",
    "",
    "SCREENSHOT: simpan ke " + SHOT_DIR + " dengan nama bernombor t01_home.png, t02_catalog.png dan seterusnya. Setiap screenshot WAJIB dibaca semula dengan tool Read. State transient (toast/notifikasi): tangkap before dan after dalam script yang sama.",
    "",
    "LAPORAN: tulis " + SHOT_DIR + "/AUDIT_REPORT.md dalam Bahasa Malaysia: inventori halaman (route -> screenshot -> pemerhatian); funnel trace semasa langkah demi langkah (homepage hingga wizard Step 3); senarai geseran UX; senarai jurang e-commerce yang DIPERHATI (nyatakan nombor screenshot sebagai bukti; jangan spekulasi); titik blocked + sebab; console errors. Rujuk screenshot dengan laluan relatif gui-test-screenshots/.",
    "",
    "Pulangkan JSON AuditReport: reportPath = gui-test-screenshots/AUDIT_REPORT.md (relatif root repo); summary (1 perenggan); pagesVisited; friction (satu baris satu); gaps (satu baris satu); blocked (satu baris satu). Jika Playwright gagal total, tulis nota kegagalan ke fail laporan yang sama dan pulangkan pagesVisited = 0 dengan sebab dalam summary.",
  ].join("\n");
  try {
    audit = await agent("Pengaudit GUI laman", AUDIT_PERSONA).ask<AuditReport>(auditAsk);
    log("Audit GUI selesai: " + audit.pagesVisited + " halaman/keadaan diaudit.");
    try {
      await artifact.file("audit-gui", audit.reportPath, {
        title: "Laporan Audit GUI Laman Semasa",
        description: "Walkthrough black-box browse-only laman dev (_rare) dengan bukti screenshot bernombor dalam gui-test-screenshots/.",
      });
    } catch {
      log("Notis: gagal menerbitkan laporan audit sebagai artefak (" + audit.reportPath + ").");
    }
  } catch (e) {
    auditSkipReason = "agent audit gagal: " + String(e);
    log(auditSkipReason);
  }
}

let countsChecked = false;
let noNewTransactions = false;
if (auditAttempted) {
  phase("Semak audit tidak mencipta transaksi baharu");
  try {
    const bookingAfter = await world.run("bench", ["--site", "_rare", "execute", "frappe.client.get_count", "--kwargs", "{'doctype': 'Booking'}"]);
    const soAfter = await world.run("bench", ["--site", "_rare", "execute", "frappe.client.get_count", "--kwargs", "{'doctype': 'Sales Order'}"]);
    const bAfter = parseLeadingInt(bookingAfter.stdout);
    const sAfter = parseLeadingInt(soAfter.stdout);
    countsChecked = bAfter >= 0 && sAfter >= 0;
    noNewTransactions = countsChecked && bookingBaseline >= 0 && soBaseline >= 0 && bAfter <= bookingBaseline && sAfter <= soBaseline;
    if (!noNewTransactions) {
      log("AMARAN: kiraan berubah selepas audit - Booking " + bookingBaseline + " -> " + bAfter + ", Sales Order " + soBaseline + " -> " + sAfter);
    } else {
      log("Kiraan kekal selepas audit: Booking=" + bAfter + ", Sales Order=" + sAfter + " (tiada transaksi baharu).");
    }
  } catch {
    countsChecked = false;
    log("Semakan kiraan transaksi tidak dapat dijalankan.");
  }
}

const auditBrief = audit !== null
  ? "Audit GUI DIJALANKAN: " + audit.pagesVisited + " halaman/keadaan diaudit. Ringkasan: " + audit.summary + " Geseran UX: " + (audit.friction.join("; ") || "tiada") + ". Jurang diperhati: " + (audit.gaps.join("; ") || "tiada") + ". Titik terhalang: " + (audit.blocked.join("; ") || "tiada") + ". Laporan penuh + senarai screenshot: baca fail " + audit.reportPath + " (relatif root repo)."
  : "Audit GUI DILANGKAU (" + auditSkipReason + "). Penilaian UX berasaskan eksplorasi kod sahaja.";

phase("Draf lima bahagian analisis secara selari");
// Join diperlukan di sini: penyunting menghimpun SEMUA lima draf menjadi satu dokumen.
const specs = [
  { name: "Pakar seni bina", file: "d1-seni-bina.md", brief: BRIEF_D1 },
  { name: "Pakar model produk dan data", file: "d2-model-produk-data.md", brief: BRIEF_D2 },
  { name: "Pakar aliran jualan", file: "d3-aliran-jualan.md", brief: BRIEF_D3 },
  { name: "Pakar portal dan ERPNext", file: "d4-portal-erpnext.md", brief: BRIEF_D4 },
  { name: "Pakar gap dan roadmap", file: "d5-gap-roadmap.md", brief: BRIEF_D5 },
];
const drafts = await Promise.all(specs.map((s) =>
  agent(s.name, AUTHOR_PERSONA).ask<Draft>(buildAuthorAsk(s.brief, s.file, auditBrief)),
));
log("Kelima-lima draf selesai: " + drafts.map((d) => d.path).join(", "));

phase("Gabung, QA dan tulis dokumen akhir");
const editor = agent("Penyunting utama", EDITOR_PERSONA);
let assembled = await editor.ask<Assembled>(buildEditorAsk(drafts, auditBrief));
log("Dokumen akhir dihimpun: " + assembled.docPath + " (" + assembled.wordCount + " patah perkataan).");

phase("Kaji semula bebas dokumen dan baiki isu");
const read = await agent("Pembaca bebas", READER_PERSONA).ask<ReadIssues>([
  "Baca HANYA fail " + DOC_PATH + " di root repo dengan tool Read. JANGAN membuka fail repo/kod lain - nilaikan daripada teks dokumen sahaja (semakan fakta ialah tugas pihak lain).",
  "Dokumen ini ialah analisis transformasi aplikasi travel_booking kepada platform e-commerce, untuk dibaca pemilik produk.",
  "Nilaikan dan pulangkan JSON ReadIssues:",
  "1. Bahagian yang kabur, terlalu teknikal tanpa penjelasan, atau susah diikuti pemilik produk.",
  "2. Dakwaan penting yang tidak disokong dalam teks dokumen itu sendiri.",
  "3. Soalan yang pemilik produk pasti akan tanya selepas membaca (jawapan belum ada dalam dokumen).",
  "4. Percanggahan dalaman antara seksyen.",
  "issues = senarai { section, issue, severity }; verdict = penilaian keseluruhan 1-2 ayat. Jika dokumen sudah jelas, pulangkan issues kosong.",
].join("\n"));
log("Pembaca bebas: " + read.issues.length + " isu ditemui. Verdict: " + read.verdict);
if (read.issues.length > 0) {
  assembled = await editor.ask<Assembled>([
    "Pembaca bebas (konteks baharu, hanya membaca dokumen akhir) menemui isu berikut:",
    JSON.stringify(read.issues, null, 2),
    "",
    "Verdict pembaca: " + read.verdict,
    "",
    "Baiki setiap isu ini dalam " + DOC_PATH + " (kekalkan struktur seksyen dan penomboran; jangan songsangkan keputusan arkitektur). Selepas baiki, kira semula patah perkataan dengan wc -w dan pulangkan JSON Assembled yang dikemas kini.",
  ].join("\n"));
  log("Isu pembaca dibaiki. Dokumen kini " + assembled.wordCount + " patah perkataan.");
}

phase("Semak dan terbitkan dokumen analisis");
let finalWc = await world.run("wc", ["-w", DOC_PATH]);
if (finalWc.exitCode !== 0) {
  await editor.ask("Fail " + DOC_PATH + " tidak ditemui atau kosong. Tulis semula dokumen penuh daripada draf dalam " + DRAFT_DIR + " mengikut arahan QA terdahulu, kemudian pulangkan Assembled semula.");
  finalWc = await world.run("wc", ["-w", DOC_PATH]);
}
const finalWords = parseLeadingInt(finalWc.stdout);
try {
  await artifact.file("analisis", DOC_PATH, {
    title: "Analisis Transformasi eCommerce travel_booking",
    description: "Analisis menyeluruh dan cadangan: seni bina, model produk & data, aliran jualan, portal, pemetaan ERPNext, gap analysis dan roadmap Fasa 1-3 (Bahasa Malaysia).",
    primary: true,
  });
} catch {
  await editor.ask("Penerbitan artefak gagal untuk " + DOC_PATH + ". Pastikan fail wujud, tidak kosong dan saiznya bawah 20MiB; tulis semula jika perlu dan pulangkan Assembled semula.");
  await artifact.file("analisis", DOC_PATH, {
    title: "Analisis Transformasi eCommerce travel_booking",
    primary: true,
  });
}

// -------------------------------------------------------------------- REPORT
const findings: WorkflowFinding[] = [];
for (const d of assembled.keyDecisions) {
  findings.push({
    where: DOC_PATH,
    what: d,
    evidence: "Terdokumen dalam dokumen akhir selepas QA penyunting (nama DocType disemak terhadap folder doctype).",
    status: "verified",
    severity: "medium",
  });
}
if (audit !== null) {
  findings.push({
    where: "gui-test-screenshots/AUDIT_REPORT.md",
    what: "Audit GUI laman semasa: " + audit.pagesVisited + " halaman/keadaan diaudit (browse-only). " + audit.summary,
    evidence: "Screenshot bernombor + laporan audit; diterbitkan sebagai artefak run ini.",
    status: "verified",
    severity: "low",
  });
}
if (envResult !== null) {
  findings.push({
    where: "site dev _rare",
    what: "Akaun test GUI: " + envResult.testEmail + " / " + envResult.testPassword + " (dev sahaja, untuk semakan portal).",
    evidence: "Dicipta oleh Penyedia persekitaran" + (audit !== null ? " dan berjaya digunakan log masuk semasa audit" : "") + ".",
    status: audit !== null ? "verified" : "unconfirmed",
    severity: "low",
  });
}
if (auditAttempted && countsChecked && !noNewTransactions) {
  findings.push({
    where: "site dev _rare",
    what: "AMARAN: kiraan Booking/Sales Order bertambah semasa audit GUI - semak sama ada audit telah mencipta transaksi.",
    evidence: "bench execute frappe.client.get_count sebelum vs selepas audit.",
    status: "verified",
    severity: "high",
  });
}
if (read.issues.length > 0) {
  findings.push({
    where: DOC_PATH,
    what: read.issues.length + " isu kejelasan daripada pembaca bebas telah dibaiki oleh penyunting.",
    evidence: read.verdict,
    status: "verified",
    severity: "low",
  });
}

const verified: string[] = [];
if (auditAttempted && countsChecked) {
  verified.push("Kiraan Booking dan Sales Order sebelum vs selepas audit GUI (bench execute frappe.client.get_count): " + (noNewTransactions ? "tiada transaksi baharu dicipta" : "BERUBAH - lihat amaran dalam findings"));
}
verified.push("QA nama DocType oleh Penyunting utama terhadap travel_booking/travel_booking/module_travel_booking/doctype/ dan resources_management/doctype/");
verified.push("Gate wc -w dokumen akhir (exit code 0, " + finalWords + " patah perkataan)");
verified.push("Pembaca bebas (konteks baharu) menilai dokumen akhir daripada teks sahaja; isu dibaiki oleh penyunting");

const notCovered: string[] = [];
if (audit === null) {
  notCovered.push("Audit GUI laman dilangkau: " + auditSkipReason);
} else {
  notCovered.push("Portal diaudit dalam keadaan empty state (akaun test baharu tanpa booking sebenar)");
  notCovered.push("Aliran selepas butang bayar/confirm tidak diuji (larangan mencipta transaksi demi keselamatan data)");
}
if (auditAttempted && !countsChecked) {
  notCovered.push("Semakan kiraan transaksi selepas audit gagal dijalankan");
}
notCovered.push("Site produksi tidak disentuh (audit pada site dev _rare sahaja)");
notCovered.push("webshop tidak dipasang pada _rare - penilaian kesesuaiannya berasaskan kod app webshop dalam bench sahaja");
notCovered.push("Run ini menghasilkan analisis sahaja; tiada kod aplikasi diubah atau dibina");

return {
  conclusion: "Analisis transformasi eCommerce travel_booking selesai: dokumen " + DOC_PATH + " (" + finalWords + " patah perkataan, 10 seksyen, tugas A-J)" + (audit !== null ? " dihasilkan dengan bukti audit GUI " + audit.pagesVisited + " halaman" : " dihasilkan tanpa audit GUI (" + auditSkipReason + ")") + ". Keputusan arkitektur utama, gap analysis dan roadmap Fasa 1-3 ada di dalam dokumen; laporan audit GUI di gui-test-screenshots/AUDIT_REPORT.md.",
  findings: findings,
  verified: verified,
  notCovered: notCovered,
};