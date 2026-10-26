# Aliran Kerja ROOMING — Analisa, Algoritma & Pseudocode

> Modul: `travel-booking-management` · Page: `/app/manage-booking-app/rooming/batch/<BATCH>`
> (atau `/rooming/group/<TRIP_GROUP_DATE>`) · Doctype teras: **Booking Reservation**
> Dokumen ini menerangkan cara proses rooming traveller berjalan DI BELAKANG
> (baca → susun → sahkan → simpan → sebar), termasuk penambahbaikan yang
> telah dilaksana.

---

## 1. Seni Bina Komponen

| Lapisan | Fail | Peranan |
|---|---|---|
| UI — tab Rooms (L2) | `module_admin_portal/page/manage_booking_app/rooming_board.js` → `render_rooming_tab()` | Grid kad bilik read-only + pintasan ke board |
| UI — tab Rooms (L3 booking) | `manage_booking_app.js` → `load_bkg_rooms()` / `render_bkg_rooms()` | Pakej rooming list yang sama (`rooms_list.js`) untuk skop SATU booking — penghuni kongsi merentas booking kekal dipapar (highlight amber) + pintasan Rooming Board group/batch |
| UI — Rooming Board (Kanban) | `rooming_board.js` → `open_rooming_board()`, `rb_move()`, `rb_save()` | Kolum = satu bilik, kad = tetamu; drag & drop (desktop) / dialog pindah (mobile) |
| UI — modal traveller | `traveller_list.js` → `show_traveller_dialog()` | Panel Rooming & Cruise Cabin per-tetamu |
| API baca | `api/manage_trip_booking.py` → `get_group_rooming()` (L2767) | Senarai bilik + penghuni + kategori untuk satu group/batch; parameter `booking` = skop satu booking (L3) |
| API simpan | `api/manage_trip_booking.py` → `arrange_group_rooming()` (L3083) | Simpan placement penuh (batch atomik) |
| API nama bilik | `api/manage_trip_booking.py` → `rename_booking_room()` (L3016) | Alias nama paparan bilik (Booking Room Alias) |
| Doctype | `module_travel_booking/doctype/booking_reservation/booking_reservation.py` | Validasi kapasiti/kategori + penjanaan Room ID + status auto |
| Doctype sokongan | `Booking Room Alias`, `Trip Price Category` (capacity/max_capacity) | Nama paparan bilik; metadata kapasiti kategori |

Route `/rooming/batch/###` ditangani oleh `manage_booking_app.js → route_apply()
→ show_rooming_board() → open_rooming_board(key)`; key = item batch/group
dalam state `S`. Ketiga-tiga fail JS dicantum server-side ke dalam SATU
scope IIFE (directive include) — jadi `S`, `api()`, `find_item()` dikongsi.

---

## 2. Model Data Rooming

SATU dokumen **Booking Reservation** = SATU slot tetamu (bukan satu bilik).
Bilik ialah konsep terbitan:

```
room_key = COALESCE(NULLIF(room_id,''), CONCAT(booking,'-Room_', IFNULL(cabin_no,0)))
```

Medan rooming pada Booking Reservation (tab Accomodation):

| Medan | Maksud |
|---|---|
| `cabin_no` | Nombor bilik dalam booking (0/kosong = Unassigned) |
| `room_id` | ID mekanikal `<booking_number>-Room_<n>`; nilai eksplisit = penempatan Open Sharing merentas booking |
| `room_category` | Link `Trip Price Category` (jenis bilik) — MESTI seragam sebilik |
| `room_privacy` | `Private` / `Open Sharing` / kosong |
| `guest_sequence` | Urutan tetamu dalam bilik (1,2,3…) — mirror rooming list kapal |
| `pax_type` | Main Guest / Extra Bed / Infant / Adult / Children |
| `stateroom_no`, `delegate_no`, `aroya_guest_no` | Pengenal cruise line |
| `cabin_is_confirmed` | Bilik telah disahkan — placement beku (kini di-enforce server) |

`Booking Room Alias` (`ROOMALIAS-{booking}-{cabin_no}`) menyimpan NAMA
PAPARAN tersuai bilik — berasingan daripada `room_id` mekanikal, jadi
pergerakan tetamu tidak menyentuh nama bilik.

---

## 3. Aliran End-to-End (Proses Kemaskini)

```
┌─ BACA ──────────────────────────────────────────────────────────────┐
│ 1. open_rooming_board(key)                                          │
│ 2. get_group_rooming(trip_groups, limit=0)                          │
│      → senarai bilik + penghuni + kategori + kapasiti               │
│ 3. rb_build_cols() → kolum draf; _origCabin direkod per tetamu      │
└──────────────────────────────────────────────────────────────────────┘
┌─ SUSUN (klien, draf sahaja — tiada tulisan DB) ─────────────────────┐
│ 4. drag & drop / dialog → rb_move(resv, targetCol)                  │
│      • kategori mesti sepadan                                       │
│      • simulasi kapasiti + peraturan pax-type (sasaran & sumber)    │
│      • merentas booking → bilik Open Sharing sahaja                 │
│ 5. Terap terus ke draf — simpan muktamad via butang Save Arrangement│
└──────────────────────────────────────────────────────────────────────┘
┌─ SIMPAN (batch atomik) ─────────────────────────────────────────────┐
│ 6. rb_save() pra-validasi draf → moves[] placement PENUH            │
│      (setiap tetamu + from_cabin_no asal)                           │
│ 7. arrange_group_rooming(moves)                                     │
│      guard: stale board → confirmed room → open sharing              │
│      diff vs DB → doc.save() hanya yang berubah (validate penuh)    │
│      refresh Trip Group Date / Flight SEKALI di hujung batch        │
│ 8. publish_realtime('travel_booking_rooming_updated', after_commit) │
└──────────────────────────────────────────────────────────────────────┘
┌─ SEBAR ─────────────────────────────────────────────────────────────┐
│ 9. Papan admin lain (rb_watch_realtime):                            │
│      tiada draf → muat semula senyap; ada draf → amaran             │
│      ECHO penyimpan diabaikan — medan 'by' siaran + guard           │
│      RB._echoGuard (tetingkap save→reload)                         │
│10. Papan penyimpan → rb_reload() dari payload segar                 │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 4. PSEUDOCODE — Baca (`get_group_rooming`)

```text
FUNGSI get_group_rooming(trip_group | trip_groups, search, privacy, limit):
    require_access()                       # roles: System/Tour Manager, Tour Operator, Accounts
    groups ← parse_groups(...)

    # KERAS 1 — kunci bilik (group by ekspresi room_key; tiada LIMIT SQL
    # kerana total_rooms diperlukan; slice ikut bilik di Python)
    room_keys ← SELECT room_key
                FROM Booking Reservation br JOIN Booking b LEFT JOIN Traveller t
                WHERE b.trip_date IN groups
                  AND br.status != 'Cancelled'
                  AND b.status NOT IN ('Cancelled','Abandoned')
                  [AND search LIKE 7-medan] [AND privacy ...]
                GROUP BY room_key ORDER BY room_key

    total_rooms ← len(room_keys)
    keys ← room_keys[:limit]  (limit ≤ 0 → semua)

    # KERAS 2 — baris penuh penghuni bagi bilik terpilih (~30 kolum,
    # COALESCE(snapshot reservation, Traveller) untuk setiap medan PII)
    rows ← SELECT ... WHERE room_key IN keys ORDER BY room_key, guest_sequence

    # KUMPUL (Python)
    rooms ← []
    UNTUK setiap r DALAM rows:
        entry ← room r.room_key (sekali)         # room_id, kategori, cabin_no,
                                                 # privacy, confirmed, customer
        entry.guests += {nama, jantina, umur, passport, status dokumen, ...}
        delegate_no bilik ← nilai pertama tak kosong penghuni
        docs_ok / pending_docs += kira status dokumen

    # PEMILIK BILIK OPEN SHARING — room_id membawa booking_number PEMILIK;
    # selaraskan entry.booking kepada pemilik sebenar supaya kad/board tak
    # tersalah booking
    UNTUK setiap room: jika room_id = '<no>-Room_<cabin>' → cari pemilik no

    # KATEGORI — SATU query batch untuk flag cruise SEMUA group (dulu N+1)
    cruise_flags ← get_all(Trip Group Date, name IN groups).is_a_cruise_trip
    categories ← get_all(Trip Price Category, ikut jenis trip)
                 + kategori bilik sedia ada (fallback kapasiti)

    # ALIAS nama paparan — satu query untuk semua booking terlibat
    alias_map ← get_all(Booking Room Alias, booking IN ...) → custom_name

    PULANG {rooms, shown, count: total_rooms, categories}
```

**Kompleksiti:** KERAS 1 = imbasan penuh group (ungkapan `COALESCE` tak
boleh berindeks — rujuk cadangan `search_index` §8), KERAS 2 berkadar
dengan bilik yang ditunjuk sahaja.

---

## 5. PSEUDOCODE — Klien: mutasi draf (`rb_move`) dan simpan (`rb_save`)

```text
FUNGSI rb_move_reject(guest, src, target):        # dikongsi semua laluan
    # Kriteria kelayakan bilik sasaran — dipanggil rb_move (draf sebenar),
    # rb_move_dialog (pra-tapis senarai bilik dalam modal) dan
    # rb_drop_move (pra-papar notis drag).
    1. KATEGORI mesti sepadan (target vs tetamu)
    2. KAPASITI & PAX-TYPE — mirror validate_cabin_capacity doctype,
       untuk SASARAN selepas ketibaan DAN SUMBER selepas pemergian
    3. MERENTAS BOOKING → bilik Open Sharing sahaja
    → pulangkan senarai masalah (kosong = layak)

FUNGSI rb_room_label(col):                        # FORMAT ROOM ID BETUL
    'BOOKING_NO-Room_<cabin>' + alias nama (bila ada) — booking_number,
    BUKAN docname Booking (kolum `name` DB; punca bug format lama).

FUNGSI rb_move(resv, target):                    # draf — tiada tulisan
    src ← kolum yang mengandungi resv
    # 0. LOCK — tetamu Custom Arrangement (🔒) tak boleh dipindah
    JIKA guest.is_custom_arrangement → ALERT "buka modal, uncheck dahulu", TOLAK
    # 1-3. rb_move_reject(guest, src, target) → ada masalah: ALERT, TOLAK
    # 4. Terap TERUS ke draf — tiada pengesahan per langkah (simpan
    #    muktamad melalui butang "Save Arrangement" / rb_save sahaja)
    pindahkan guest: src.guests → target.guests
    guest._newSeq      ← len(target)+1     # sequence ikut penghuni sasaran
                                          # (kecuali modal dah set/reset)
    guest._crossRoomId ← room_id sasaran (penempatan merentas booking sahaja)

FUNGSI rb_drop_move(resv, target):               # NOTIS DRAG & DROP
    # Validasi + lock berjalan SEBELUM popup (notis tak pernah tawarkan
    # perpindahan tak sah). Popup:
    #   "You are moving this traveller FROM [rb_room_label(src)]
    #    INTO [rb_room_label(target)]"
    # footer: checkbox "I acknowledge this move" (kiri, WAJIB)
    #       + butang Move (kanan — disabled sehingga tick)
    # tick + Move → rb_move(resv, target)

FUNGSI rb_move_dialog(guest, srcCol):            # modal Move Guest
    # TABS + dua form berasingan:
    # TAB [Update Info] — dua kolum vertical: Room Arrangement (kiri:
    #   room_id ro rb_room_label / cabin_no ro / guest_sequence EDITABLE
    #   — kosong = reset auto) · Cruise Arrangement (kanan: stateroom_no
    #   ro / delegate_no ro / aroya_guest_no EDITABLE)
    #   + declaration Custom Arrangement + Save Details + Reset Rooming
    #   Number (semua dalam form sama; dirty-flag per medan)
    # TAB [Move] — Current Room ID (ro) + New Room AUTOCOMPLETE (boleh
    #   cari; MULA KOSONG) — senarai = bilik layak PRA-TAPIS
    #   rb_move_reject + "No Arrangement (Unassigned)". PILIHAN KOSONG =
    #   TIADA PENEMPATAN → kolum Unassigned booking sendiri (cabin 0);
    #   butang → "Remove Arrangement". Unassigned sentiasa sah (tiada
    #   kriteria bilik); hanya peraturan pax-type bilik SUMBER berjalan.
    # Reset Rooming Number — DRAF TETAMU INI SAHAJA: pratonton susunan
    #   asal (SO utama, get_booking_rooming_source_order) → rb_move draf
    #   ke cabin asal; DB ditulis "Save Arrangement" sepenuhnya — draf
    #   lain KEKAL, tiada reload papan (resetRooming server-flag kekal
    #   untuk caller API lain).

FUNGSI rb_save(key):
    # Pra-validasi draf (over-capacity / Extra Bed / Infant) — supaya
    # save sentiasa berjaya, tiada 417 server
    UNTUK setiap kolum: semak max_capacity & peraturan pax-type
        → ada masalah: MSGPRINT, TOLAK

    # Payload PLACEMENT PENUH (bukan diff)
    moves ← []
    UNTUK setiap kolum col, setiap tetamu g:
        moves += {
            reservation:  g.reservation,
            cabin_no:     col.cabin_no,
            from_cabin_no: g._origCabin,          # ← save-guard stale board
            room_category: col.room_category,
            room_id:      (g._crossRoomId jika penempatan merentas booking
                           else ''),               # kosong → server jana semula
            guest_sequence: g._newSeq (tetamu dipindah / edit modal sahaja;
                               0 = reset nombor auto),
            room_privacy / stateroom_no / delegate_no / cabin_is_confirmed,
            aroya_guest_no (edit modal sahaja),
            is_custom_arrangement (toggle modal sahaja)
        }

    out ← api('arrange_group_rooming', {moves})
    → alert hijau (kiraan / "no changes")
    → load_tab(key,'rooming')        # cache tab L2 digegarkan
    → rb_reload(key)                 # papan dibina semula dari DB segar
```

---

## 6. PSEUDOCODE — Server: `arrange_group_rooming` (kemaskini sebenar)

```text
FUNGSI arrange_group_rooming(moves):
    require_access()
    moves ← parse JSON jika string
    seen ← set(); updated ← []
    affected_groups ← []; affected_flights ← []; group_cache ← {}

    UNTUK setiap mv DALAM moves:
        reservation ← mv.reservation (buang duplikasi — terakhir menang)
        doc ← get_doc(Booking Reservation, reservation)
        JIKA doc.status = 'Cancelled' → THROW

        cabin_no ← int(mv.cabin_no);  cabin_no < 0 → THROW

        # ── GUARD 1: STALE BOARD ────────────────────────────────────
        # from_cabin_no = cabin yang dilihat klien masa papan dimuatkan.
        # Tanpa guard: placement penuh menyala(dulu) mengEMBALIKAN tetamu
        # ke posisi lapuk secara senyap (last-write-wins antara 2 admin).
        JIKA mv.from_cabin_no ≠ doc.cabin_no → THROW "board out of date,
            reload dan cuba lagi"        # atomik: seluruh batch dibatalkan

        # Nilai hasrat TANPA mutasi (guard perlu tahu niat dahulu)
        moves_cabin / changes_room / changes_category / changes_seq ← diff

        # ── GUARD 2: BILIK CONFIRMED ────────────────────────────────
        # read_only_depends_on UI boleh dilangkau dengan panggilan API
        # terus — kini placement (cabin/room_id/kategori/sequence) bilik
        # cabin_is_confirmed DIBEKUKAN di server. Uncheck Confirmed
        # sendiri kekal dibenarkan (cara sah "cairkan" bilik).
        JIKA doc.cabin_is_confirmed DAN (moves_cabin ATAU changes_room
            ATAU changes_category ATAU changes_seq) → THROW

        # ── GUARD 2b: CUSTOM ARRANGEMENT ───────────────────────────
        # Declaration modal Move Guest — susunan KHAS disengajakan.
        # SEMUA mutasi melalui API ni beku: placement + sifat bilik
        # (privacy/stateroom/delegate/confirmed) + maklumat cruise
        # (aroya). Uncheck Custom Arrangement sendiri (field
        # is_custom_arrangement=0) kekal dibenarkan ("cairkan").
        JIKA doc.is_custom_arrangement DAN BUKAN unset-custom
            DAN (changes apa-apa di atas) → THROW

        # ── GUARD 3: OPEN SHARING MERENTAS BOOKING ──────────────────
        # room_id eksplisit milik booking lain hanya sah bila bilik
        # sasaran wujud & berstatus Open Sharing (dulu client-side sahaja).
        JIKA changes_room DAN room_id milik booking lain:
            occupants ← get_all(room_id = sasaran, status != Cancelled)
            JICA kosong → THROW "bilik tiada"
            JIKA privacy ≠ 'Open Sharing' → THROW

        # ── MUTASI (hanya selepas semua guard lulus) ────────────────
        changed ← false
        kategori ≠ → doc.room_category = kategori
        room_id eksplisit ≠ → doc.room_id = room_id
        cabin ≠ → doc.cabin_no = cabin;  room_id dikosongkan (lama tanpa medan)
        sequence = 0 → RESET nombor auto (penghuni cabin + 1)
        sequence baharu (>0) ≠ → doc.guest_sequence
        privacy / stateroom / delegate / confirmed ≠ → set (fan-out per penghuni)
        aroya_guest_no ≠ (modal Move Guest) → set / clear
        is_custom_arrangement ≠ (modal Move Guest) → set / clear

        JIKA changed:
            doc.flags.skip_refresh_related = 1      # ← tunda refresh
            doc.save(ignore_permissions=True)       # validate() doctype PENUH:
                                                    # sync_document_status →
                                                    # apply_auto_status →
                                                    # assign_room_id →
                                                    # validate_cabin_capacity →
                                                    # sync_booking_money_snapshot
            updated += doc
            kumpul trip_group(doc.booking) & doc.flight → affected_*

    JIKA updated kosong → PULANG {count: 0, "no changes"}

    # ── REFRESH TERTUNDA: sekali per trip group / flight ───────────
    # (dulu: N save × refresh_bookings seluruh group = write amplification)
    UNTUK g DALAM affected_groups: get_doc(Trip Group Date, g).refresh_bookings()
    UNTUK f DALAM affected_flights: get_doc(Flight, f).refresh_seats()

    # ── SIARAN REALTIME (selepas commit) ───────────────────────────
    publish_realtime('travel_booking_rooming_updated',   # by = user
                     {trip_groups: affected_groups, count}, after_commit=True)

    PULANG {updated, count}
```

**Sifat penting:**
- **Atomik** — sebarang `frappe.throw` membatalkan SELURUH request
  (rollback automatik Frappe); tiada perubahan tergantung.
- **Idempoten-ish** — hanya dokumen yang benar-benar berubah disave;
  save berulang tanpa perubahan → `count: 0`, tiada tulisan.
- **Selamat concur** — guard stale board menolak simpanan berasaskan
  papan lapuk; realtime memberitahu papan lain supaya muat semula.

### 6b. Validasi doctype (`validate_cabin_capacity`) — jaring akhir

```text
JIKA flags.skip_cabin_capacity_validation → skip (laluan force resync)
JIKA booking/cabin_no/pax_type/room_category kosong → skip senyap (rekod lama)

JIKA cabin_no > get_max_cabins() → THROW
siblings ← semua reservation lain booking+cabin sama
JIKA ada sibling room_category BERBEZA → THROW   # satu bilik satu kategori

is_cruise ← Booking.is_a_cruise_trip
main ← kira 'Main Guest' (cruise) ATAU 'Adult' (darat); extra ← 'Extra Bed'/'Children'
(capacity, max_capacity) ← Trip Price Category; max_capacity 0 = TANPA HAD

cruise: Main ≤ capacity; Extra Bed sah bila Main = penuh; Infant perlu ≥1 Main
darat:  Children/Infant perlu ≥1 Adult
total ≤ max_capacity (kecuali unlimited) → sebaliknya THROW
```

---

## 7. Penambahbaikan Yang Dilaksana

| # | Penambahbaikan | Fail | Kesan |
|---|---|---|---|
| 1 | **Guard stale board** — `from_cabin_no` pada setiap move; server banding dengan DB, mismatch → tolak seluruh batch | `manage_trip_booking.py` `arrange_group_rooming` + `rooming_board.js` `rb_save` | Menutup bug last-write-wins: dua admin buka board serentak, save penuh placement tak lagi mengembalikan tetamu orang lain ke posisi lapuk secara senyap |
| 2 | **Guard bilik confirmed server-side** — placement bilik `cabin_is_confirmed` ditolak di API (dulu UI `read_only_depends_on` sahaja, boleh dilangkau) | `arrange_group_rooming` | Integriti susunan yang telah disahkan (hantar ke cruise line dsb.) |
| 3 | **Guard Open Sharing server-side** — `room_id` eksplisit merentas booking disemak: bilik sasaran wujud & Open Sharing | `arrange_group_rooming` | Peraturan perkongsian merentas booking kini di-enforce di server, bukan hanya `rb_move` klien |
| 4 | **Refresh tertunda** — `flags.skip_refresh_related` per-doc; SATU `refresh_bookings()`/`refresh_seats()` per group/flight di hujung batch | `arrange_group_rooming` + `booking_reservation.py` `refresh_related` | Batch 100 tetamu: ~100 refresh group → 1 refresh. Kiraan idempoten, transaksi sama, keputusan akhir seragam |
| 5 | **Realtime** — siaran `travel_booking_rooming_updated` (after-commit); papan admin lain muat semula senyap bila tiada draf, amaran bila ada draf | `arrange_group_rooming` + `rooming_board.js` `rb_watch_realtime`/`rb_unwatch_realtime`/`rb_reload` | Papan berbilang admin kekal segar tanpa reload manual |
| 6 | **N+1 cruise flag dibuang** — satu query batch untuk semua group | `get_group_rooming` | Batch 10 group = 10 query → 1 |
| 7 | **Umur dikira sekali** per tetamu (dulu 2×) | `get_group_rooming` | −50% kiraan umur pada board besar |
| 8 | **Dead code dibuang** — `alias_name` dikira dua kali | `rename_booking_room` | Kebersihan |

**Pengesahan yang telah dijalankan** (site `trip.rarecation.com`):
round-trip no-op `get_group_rooming` → `arrange_group_rooming` (`count: 0`,
tiada tulisan); ketiga-tiga guard berfungsi (throw sebelum mutasi);
laluan simpan sebenar (unassign → `count: 1`, refresh tertunda tanpa ralat)
diikuti `ROLLBACK` — data produksi kembali asal.

---

## 8. Cadangan Lanjutan (belum dilaksana)

1. **`search_index` pada `room_id` & `cabin_no`** (Booking Reservation) —
   KERAS 1 `get_group_rooming` mengumpulkan ikut ekspresi `COALESCE` yang
   tidak berindeks; indeks kolum asas membantu pelan query. Perlu
   `bench migrate` selepas ubah JSON doctype.
2. **`guest_sequence` race** — `set_guest_sequence()` guna `count+1`;
   dua insert serentak boleh jana nombor pendua. Penyelesaian: unique
   constraint `(booking, cabin_no, guest_sequence)` ATAU lock baris
   booking semasa insert batch.
3. **`get_cabin_grid` / `bulk_assign_staterooms`** (`api/booking_hub.py`) —
   N+1 teruk (get_doc per reservation) dan `frappe.db.commit()` manual di
   dalam whitelisted method (partial commit). Padankan corak batch +
   guard yang sama.
4. **Pagination board penuh** — board memuat `limit: 0` (semua bilik
   batch); untuk batch > ~200 bilik, pertimbangkan render maya kolum.
5. **Rooming audit log** — Version standard Frappe menangkap perubahan,
   tetapi ringkasan "siapa pindahkan tetamu X dari bilik A ke B" perlu
   diperoleh dari Version; boleh tambah doctype ringkas rooming log bila
   perlu laporan.
