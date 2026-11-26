# Pelan: Trip Manager — Aplikasi Pengurusan Penuh (Full Management App)

## Konteks

Trip Manager sekarang read-only (semua edit lompat ke Desk form doctype). Keperluan: **urus trip + semua elemen + kandungan website tanpa akses doctype terus**, dengan automasi & kiraan dibantu — konsep ditiru daripada `workspace_sidebar/travel_booking_management.json` (IA berkelompok: produk/penerbangan/destinasi/tempahan/pembilan/portal/tetapan).

**Dapatan eksplorasi kritikal (guna semula, jangan bina semula):**
- **`api/trip_manager.py` lama (493 baris) TIDAK DIGUNAKAN mana-mana page** — CRUD lengkap sedia ada: `get_managed_trips`, `get_trip_bundle` (data editor penuh + lookups), `save_trip`, `save_group_date` (dengan `_apply_cruise_fetch` automation), `save_package` (pricing reuse by row name), `delete_doc` (Trip/TGD/Package sahaja). Prinsip: semua tulis via `get_doc.save()` supaya validate() jalan.
- `update_website_setting(field, value)` (trip_command_center.py:570) — tulis scalar Travel Website.
- Automasi sedia ada: sync_cruise_only_group_date, cabin availability sync, auto-status, price propagation.
- **Yang HILANG**: API kandungan Trip (highlights/features/faqs/facilities/galeri), API import harga cruise server-side, API child-tables Travel Website (benefits/testimonials/stats/menu).

## Seni bina

### Routing (kekalan + baharu)
```
/trip-manager                    → landing hub (kad + kiraan) [sedia]
/trip-manager/trips              → senarai trip [sedia, tambah butang New]
/trip-manager/trip/<name>        → WORKSPACE EDITOR PENUH (naik taraf besar)
/trip-manager/flight-schedules   → [sedia] + modal create/edit FS + tambah PNR
/trip-manager/cruise-schedules   → [sedia] + modal create/edit + import rates
/trip-manager/extras             → [sedia] + modal create/edit addon+package
/trip-manager/website            → BAHARU: editor kandungan website
```

## Bahagian 1 — Workspace Trip jadi Editor Penuh (`/trip/<name>`)

Naik taraf `renderTripWorkspace` + API:

### 1A. Header dengan tindakan
- Info trip inline-editable (nama, status, published toggle, description ringkas) melalui `save_trip` sedia ada
- Butang: **New Trip Date**, **New Package** (sedia direka), **Import Cruise Rates** (baharu — lihat 1D)

### 1B. Seksyen Trip Dates — baris + modal edit
- Setiap baris TGD: butang edit → **modal dialog** (frappe.ui.dialog) dengan medan betul (tarikh, sailing, kapasiti, status, cruise_schedule, flight_schedule) — tulis melalui `save_group_date` (automation `_apply_cruise_fetch` kekal berjalan)
- Paparan langsung kiraan: booked/seats-left (sedia), **duration auto-kira** (return−departure+1), status auto explained
- Butang tambah TGD baharu (modal kosong → save_group_date create)

### 1C. Seksyen Packages — kad + modal edit penuh
- Butang edit → modal dengan tab: Info (jenis/currency/featured/airport) / **Dates** (multiselect TGD) / **Pricing matrix** (jadual kategori × 6 harga + currency per baris — reka bentuk grid inline dalam modal) / **BOM components** (senarai + tambah baris: type→link, qty, per_pax, mode)
- Tulis melalui `save_package` sedia ada (pricing reuse by name, M:N dates full-replace) + **API baharu `save_package_components`** (child BOM)
- Kiraan langsung: from-price (MIN), currencies set, affected dates count

### 1D. Automasi dalam workspace
- **`import_cruise_rates(trip_package)` API baharu** (salin `import_from_cruise_rate` trip_package.js:26-68 ke server — loop TGD pertama → cruise_schedule.cabin_rates → package_pricing; amaran bila pricing sedia ada akan ditimpa)
- Butang **"Sync Availability"** per cruise schedule → `refresh_cabin_availability` sedia ada
- Paparan derived: BOM summary, schedule linkage badges (warna hijau/merah bila tiada cruise/flight schedule pada TGD fly-cruise)

### 1E. Kandungan Trip (baharu — API + tab dalam workspace)
- **API `save_trip_content(trip, payload)`**: description (Text Editor HTML), highlights, features (included flag), faqs (Q/A), facilities, video_url — child tables full-replace melalui get_doc.save()
- **API `upload_trip_image(trip, filedata)` + `remove_trip_image`**: attach image (frappe.get_doc File, attached_to Trip, is_private=0) → galeri automatik (trip.py get_context sedia baca tabFile)
- Tab "Content" dalam workspace: borang description (HTML editor ringkas), jadual highlights/features/faqs/facilities (add/remove/edit inline), galeri (thumbnail grid + upload + remove)

## Bahagian 2 — Seksyen Website (`/website`)

### 2A. API
- **`save_website_section(section, payload)`** baharu (trip_manager_page.py): tulis scalar fields melalui corak `update_website_setting` + child tables (menu/stats/benefits/testimonials/footer links) full-replace; on_update Travel Website auto-clear cache (sedia ada)
- Baca melalui `get_website_settings` sedia ada (cached 600s — tambahkan cache-invalidate selepas save)

### 2B. UI
- Sub-tab **Cruise** / **Tour** / **Common**:
  - Hero (tag/title/intro/background upload/search label) + Stats (jadual)
  - Featured (tag/title/subtitle/CTA)
  - Why Us + Benefits (jadual icon+title+desc)
  - Testimonials (jadual)
  - CTA block
  - Common: footer tagline/links (jadual)/socials/chat widget/GA/date format
- Preview link ke /cruise, /tour (open new tab)

## Bahagian 3 — Seksyen sedia ada + modal edit

- **Flight Schedules**: modal create/edit FS (schedule_code, status, TGD link) + dalam modal: jadual PNR (tambah baris Link Flight + role + note, buang) → API `save_flight_schedule` baharu (validasi duplikasi sedia pada controller)
- **Cruise Schedules**: modal create/edit (ship, sailing, ports, status) + paparan kabin rates ringkas + butang sync availability
- **Extras**: modal Trip Addon (title/type/organizer) + modal Trip Addon Package (rates per currency jadual, scoping, validity, caps) → API `save_addon`, `save_addon_package` baharu (ikut prinsip get_doc.save)

## Bahagian 4 — Landing hub dikaya
- Kiraan sedia (get_overview_counts) + link pantas: pergi ke workspace trip terbaru, "Price Review" queue (pakej berflag), PNR yatim (sedia)

## Fail kritikal
| Fail | Perubahan |
|---|---|
| `api/trip_manager_page.py` | +API: save_trip_content, upload/remove_trip_image, import_cruise_rates, save_package_components, save_flight_schedule, save_addon, save_addon_package, save_website_section, sync helpers |
| `api/trip_manager.py` (lama) | Guna semula terus (save_trip/save_group_date/save_package/get_trip_bundle/delete_doc) — tak diubah |
| `module_admin_portal/page/trip_manager/trip_manager.js` | Naik taraf besar: modal dialogs, tab Content dalam workspace, seksyen /website, modal FS/CS/Extras |
| `public/css/trip_manager.css` | Gaya modal-grid, editor tables, tab content, badges |
| `api/trip_command_center.py` | get_website_settings diguna semula (baca) |

## Verification

1. **Unit**: API baharu — kandungan trip (mock), import rates (schedule→pricing), save FS (validasi duplikat), website section (cache invalidate).
2. **Ujian CRUD end-to-end (bench console)**: cipta trip ujian → TGD → pakej + import kadar → BOM baris → kandungan (description+FAQ+gambar ujian) → FS dengan PNR → pulihkan (padam melalui delete_doc API).
3. **GUI black-box (Playwright, corak lepas)**: log masuk → /trips → ruang kerja → buka modal TGD → edit → simpan → semak perubahan dipaparkan; tab Kandungan → muat naik gambar → kelihatan dalam galeri; /website → ubah tajuk hero cruise → semak cache dikosongkan → curl /cruise memaparkan tajuk baharu; semua laluan (T1-T7 lepas) kekal hijau.
4. **Regression**: 74 ujian sedia ada + node --check + compile.
5. **Keselamatan ujian**: tapisan sesi + kata laluan pentadbir dikosongkan selepas ujian GUI (corak lepas, **maklumkan pengguna terlebih dahulu** mengenai tetapan semula kata laluan pentadbir).