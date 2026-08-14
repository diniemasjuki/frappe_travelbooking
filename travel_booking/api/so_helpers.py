# travel_booking/api/so_helpers.py
#
# Helper-helper berkaitan Sales Order (SO), Customer, Payment Entry,
# dan auto-invoice. Semua fungsi di sini INTERNAL (tiada @whitelist)
# — dipanggil oleh booking_engine.py dan email_service.py sahaja.
#
# Modul ni TIDAK import email_service.py (elak circular import) —
# booking_engine.py yang jadi "orchestrator" yang panggil kedua-duanya.

import frappe

from travel_booking.api.constants import TRAVEL_ITEM_CODE


# ══════════════════════════════════════════════
# SO RESOLUTION (Booking <-> Sales Order link)
# ══════════════════════════════════════════════

def _resolve_booking_from_so(so_name):
    """Cari nama Booking yang berkaitan dengan SO ni, terus melalui
    Sales Order.custom_booking. Pulang None kalau tiada kaitan.
    """
    return frappe.db.get_value("Sales Order", so_name, "custom_booking")


def _get_all_booking_sales_orders(booking_name, include_cancelled=False):
    """Semua SO yang berkaitan booking ni, melalui Sales Order.custom_booking
    (satu-satunya sumber rujukan — utama dan addon setara secara struktur).
    Secara default, SO Cancelled (docstatus=2) DIKECUALIKEN — supaya tak
    masuk kiraan Total/Payment Status/booking_status/waterfall allocation.
    Guna include_cancelled=True HANYA untuk paparan UI (transparency),
    bukan untuk logic status atau pembayaran.
    """
    filters = {"custom_booking": booking_name}
    if not include_cancelled:
        filters["docstatus"] = ["!=", 2]
    return frappe.get_all("Sales Order", filters=filters, pluck="name")


def _get_primary_so(booking_name):
    """SO 'utama' (cabin booking asal) — ditakrif sebagai SO PERTAMA yang
    dicipta untuk booking ni (creation paling awal), bukan field berasingan.
    Ini gantikan Booking.sales_order sepenuhnya — one-to-many standard
    (Sales Order.custom_booking → Booking), bukan rujukan dua-hala.
    """
    return frappe.db.get_value(
        "Sales Order", {"custom_booking": booking_name},
        "name", order_by="creation asc"
    )


def _compute_payment_status(paid, total):
    """Kira nilai Payment Status (field 'payment_status' pada Booking, BUKAN
    virtual) dari jumlah dibayar vs jumlah keseluruhan SO. Refund status
    (Request Refund/Pending Refund/Refunded) TIDAK dikira di sini — ia
    ditetapkan secara berasingan melalui proses cancel/refund (rujuk
    _cancel_booking_cascade dan proses refund manual admin).
    """
    if paid <= 0:
        return "Pending"
    elif paid >= total - 0.001:
        return "Paid"
    return "Partially Paid"


# ══════════════════════════════════════════════
# CUSTOMER CREATION
# ══════════════════════════════════════════════

def _create_customer(billing):
    customer = frappe.get_doc({
        "doctype":        "Customer",
        "customer_name":  billing.get("full_name"),
        "customer_type":  "Individual",
        "customer_group": frappe.db.get_single_value(
                            "Selling Settings", "customer_group") or "Individual",
        "territory":      frappe.db.get_single_value(
                            "Selling Settings", "territory") or "All Territories",
    })
    customer.insert(ignore_permissions=True)

    contact = frappe.get_doc({
        "doctype":    "Contact",
        "first_name": billing.get("full_name"),
        "email_ids":  [{"email_id": billing.get("email"), "is_primary": 1}],
        "phone_nos":  [{"phone": billing.get("phone"), "is_primary_phone": 1}],
        "links":      [{"link_doctype": "Customer", "link_name": customer.name}],
    })
    contact.insert(ignore_permissions=True)
    return customer.name


# ══════════════════════════════════════════════
# SALES ORDER ITEMS
# ══════════════════════════════════════════════

def _build_so_items(selections, pricing_map, trip_name="", group_label=""):
    """Bina SO items dengan harga dari backend pricing_map.
    Model SLOT (posisi bilik): Main Guest (single/twin) / Extra Bed /
    Infant. Harga ditentukan oleh SLOT, bukan label umur — kecuali Infant
    yang sentiasa guna price_infant sendiri.
    """
    items        = []
    default_item = _get_or_create_travel_item()

    for cabin_no, sel in enumerate(selections, start=1):
        room_category = sel.get("room_category")
        main_guests   = int(sel.get("main_guests", 0))
        extra_beds    = int(sel.get("extra_beds", 0))
        infants       = int(sel.get("infants", 0))

        price = pricing_map.get(room_category)
        if not price:
            frappe.throw("Price not found for category: " + str(room_category))

        if main_guests == 1:
            items.append(_so_line(default_item, room_category, "Main Guest (Single)",
                                  1, float(price.price_adult_single or 0),
                                  trip_name, group_label, cabin_no))
        elif main_guests >= 2:
            items.append(_so_line(default_item, room_category, "Main Guest",
                                  main_guests, float(price.price_adult or 0),
                                  trip_name, group_label, cabin_no))
        if extra_beds > 0:
            items.append(_so_line(default_item, room_category, "Extra Bed",
                                  extra_beds, float(price.price_upperberth or 0),
                                  trip_name, group_label, cabin_no))
        if infants > 0:
            items.append(_so_line(default_item, room_category, "Infant",
                                  infants, float(price.price_infant or 0),
                                  trip_name, group_label, cabin_no))
    return items


def _so_line(item_code, room_category, pax_type, qty, rate, trip_name, group_label, cabin_no=1):
    cabin_tag = "Cabin " + str(cabin_no)
    return {
        "item_code":   item_code,
        "item_name":   room_category + " (" + cabin_tag + ") \u2014 " + pax_type,
        "qty":         qty,
        "rate":        rate,
        "uom":         "Nos",
        "description": trip_name + " | " + group_label + " | " + room_category + " | " + cabin_tag + " | " + pax_type,
    }


def _get_or_create_travel_item():
    if frappe.db.exists("Item", TRAVEL_ITEM_CODE):
        return TRAVEL_ITEM_CODE

    frappe.get_doc({
        "doctype":                       "Item",
        "item_code":                     TRAVEL_ITEM_CODE,
        "item_name":                     "Travel Package",
        "item_group":                    "Services",
        "stock_uom":                     "Nos",
        "is_stock_item":                 0,
        "is_sales_item":                 1,
        "include_item_in_manufacturing": 0,
    }).insert(ignore_permissions=True)
    return TRAVEL_ITEM_CODE


# ══════════════════════════════════════════════
# CABIN LAYOUT (from Sales Order)
# ══════════════════════════════════════════════

def _cabin_layout_from_so(so_name):
    """Susunan cabin dari SO items (SO = sumber tunggal), ikut turutan cabin.
    description: 'Trip | Group Label | Room Category | Cabin N | Pax Type'.
    Return: [{cabin_no, room_category, pax, pax_breakdown}] disusun ikut
    cabin_no. pax_breakdown = {"Main Guest": 2, "Extra Bed": 1, ...} —
    pecahan pax_type SEBENAR yang customer beli untuk cabin ni, perlu
    untuk isi cabin_no/pax_type pada setiap Booking Reservation individu
    (rujuk _activate_booking()). 'pax' (jumlah keseluruhan) dikekalkan
    untuk backward compat dengan caller sedia ada (portal_booking.py
    Pass 2 grouping) yang cuma perlukan kuantiti, bukan breakdown.
    """
    items = frappe.db.get_all("Sales Order Item",
                              filters={"parent": so_name},
                              fields=["description", "qty"], order_by="idx")
    layout = {}
    for it in items:
        parts = (it.description or "").split(" | ")
        if len(parts) < 5:
            continue
        room_category = parts[2].strip()
        cabin_tag     = parts[3].strip()
        pax_type      = parts[4].strip()

        # PENTING: "Main Guest (Single)" cuma label PRICING/paparan (beza
        # price_adult_single vs price_adult — rujuk _build_so_items()) —
        # dari segi kapasiti/kiraan slot Booking Reservation, ia SAMA
        # dengan "Main Guest" biasa (satu-satu tetap ambil 1 slot). Field
        # pax_type (Select) pada Booking Reservation cuma terima 3 nilai
        # tetap ("Main Guest"/"Extra Bed"/"Infant") — tanpa normalize ni,
        # _activate_booking() akan cuba simpan "Main Guest (Single)" terus
        # dan Frappe tolak dengan error validation (LinkValidationError
        # gaya Select), block booking/update Payment Entry yang trigger
        # laluan ni.
        if pax_type == "Main Guest (Single)":
            pax_type = "Main Guest"

        try:
            cabin_no = int(cabin_tag.lower().replace("cabin", "").strip())
        except Exception:
            continue
        if cabin_no not in layout:
            layout[cabin_no] = {"cabin_no": cabin_no, "room_category": room_category, "pax": 0, "pax_breakdown": {}}
        qty = int(it.qty or 0)
        layout[cabin_no]["pax"] += qty
        layout[cabin_no]["pax_breakdown"][pax_type] = layout[cabin_no]["pax_breakdown"].get(pax_type, 0) + qty
    return [layout[n] for n in sorted(layout.keys())]


def _activate_booking(booking_name):
    """Cipta Booking Reservation (status Confirmed) bila booking Confirmed.
    Idempotent. Reservation dicipta dengan room_category + cabin_no +
    pax_type terisi (bukan cuma room_category macam sebelum ni) — setiap
    slot individu terus tahu cabin & jenis pax dia dari mula, konsisten
    dengan apa customer beli di SO, dan sepadan dengan validate() capacity
    check baharu (rujuk booking_reservation.py) yang bergantung pada
    field-field ni. flight & stateroom_no tetap admin assign kemudian.
    Cabin layout diambil dari SO UTAMA (cabin booking asal), bukan addon SO.
    """
    if frappe.db.count("Booking Reservation", {"booking": booking_name}):
        return 0
    so_name = _get_primary_so(booking_name)
    if not so_name:
        return 0
    count = 0
    for cabin in _cabin_layout_from_so(so_name):
        for pax_type, qty in cabin.get("pax_breakdown", {}).items():
            for _ in range(int(qty)):
                frappe.get_doc({
                    "doctype":         "Booking Reservation",
                    "booking":         booking_name,
                    "room_category":   cabin.get("room_category"),
                    "cabin_no":        cabin.get("cabin_no"),
                    "pax_type":        pax_type,
                    "status":          "Confirmed",
                    "document_status": "Pending",
                }).insert(ignore_permissions=True)
                count += 1
    return count


# ══════════════════════════════════════════════
# PAYMENT ENTRY (Manual Transfer)
# ══════════════════════════════════════════════

def _create_manual_payment_entry(so_name, customer_name, amount, receipt_data="", label="receipt", bank_transfer_ref=""):
    """Manual transfer — cipta Payment Entry DRAFT + attach resit.
    Draft (docstatus 0) = menunggu admin verify & submit. Corak sama dgn portal.
    """
    import base64
    from erpnext.accounts.party import get_party_account

    so = frappe.db.get_value("Sales Order", so_name, ["company", "currency"], as_dict=True)
    if not so:
        return None

    original_user = frappe.session.user
    frappe.set_user("Administrator")
    try:
        company = so.company or frappe.db.get_single_value("Global Defaults", "default_company")
        # MULTI-CURRENCY: cari paid_to account KHUSUS untuk currency SO ni
        # dari Travel Settings.currency_accounts (satu baris per currency —
        # rujuk dokumen reka bentuk multi-currency). Fallback ke Account
        # jenis Bank PERTAMA yang jumpa untuk company ni kalau currency SO
        # tiada baris dikonfigurasikan (tak patut berlaku dalam praktik —
        # Manual Transfer sepatutnya disembunyikan di frontend untuk
        # currency yang tiada konfigurasi — tapi jaring keselamatan supaya
        # admin verify manual tak terus gagal kalau ada gap konfigurasi).
        paid_to = None
        travel_settings = frappe.get_cached_doc("Travel Settings")
        for row in (travel_settings.get("currency_accounts") or []):
            if row.currency == so.currency and row.manual_transfer_paid_to_account:
                paid_to = row.manual_transfer_paid_to_account
                break
        if not paid_to:
            frappe.log_error(
                "Manual Transfer paid_to account not configured for currency '" +
                str(so.currency) + "' (SO " + so_name + "). Using fallback to the " +
                "first Bank-type Account for the company — please configure it in " +
                "Travel Settings > Multi Currency Account.",
                "Manual Transfer - Currency Account Missing"
            )
            paid_to = frappe.db.get_value("Account",
                {"account_type": "Bank", "company": company, "is_group": 0}, "name")
        party_account = get_party_account("Customer", customer_name, company)
        # MULTI-CURRENCY — DIRINGKASKAN: get_party_account() ERPNext
        # pulangkan akaun Debtors DEFAULT company (biasanya MYR) — ini
        # SEKARANG selamat diguna terus untuk apa-apa currency SO, sejak
        # Accounts Settings "Allow multi-currency invoices against single
        # party account" dihidupkan (rujuk sesi debug/dokumen reka bentuk
        # multi-currency). Override receivable_account custom TIDAK lagi
        # diperlukan.

        pe = frappe.new_doc("Payment Entry")
        pe.payment_type    = "Receive"
        pe.company         = company
        pe.posting_date    = frappe.utils.today()
        pe.party_type      = "Customer"
        pe.party           = customer_name
        pe.party_account   = party_account
        pe.paid_from       = party_account
        pe.paid_to         = paid_to
        pe.paid_amount     = float(amount)
        pe.received_amount = float(amount)
        # PENTING: reference_no = nombor rujukan/transaksi DARI BANK
        # CUSTOMER SENDIRI (bukan nombor SO kami) — inilah tujuan asal
        # field "Cheque/Reference No" dalam Payment Entry ERPNext, untuk
        # admin padankan bayaran ni dengan penyata bank semasa verify.
        # Pautan ke SO sendiri sudah cukup dikesan melalui child table
        # 'references' di bawah — reference_no tak perlu (dan sebelum ni
        # SALAH) diisi dengan so_name yang redundant.
        pe.reference_no    = bank_transfer_ref or so_name
        pe.reference_date  = frappe.utils.today()
        pe.append("references", {
            "reference_doctype": "Sales Order",
            "reference_name":    so_name,
            "allocated_amount":  float(amount),
        })
        pe.remarks = "Manual transfer (booking) for " + so_name + \
                     (". Ref: " + bank_transfer_ref if bank_transfer_ref else "") + \
                     ". Pending verification."
        pe.insert(ignore_permissions=True)

        if receipt_data:
            ext = ".png"
            if receipt_data.startswith("data:"):
                head = receipt_data.split(",")[0]
                if "pdf" in head:
                    ext = ".pdf"
                elif "jpeg" in head or "jpg" in head:
                    ext = ".jpg"
                elif "png" in head:
                    ext = ".png"
                receipt_data = receipt_data.split(",")[1]
            file_content = base64.b64decode(receipt_data)
            frappe.get_doc({
                "doctype":             "File",
                "file_name":           label + ext,
                "attached_to_doctype": "Payment Entry",
                "attached_to_name":    pe.name,
                "is_private":          1,
                "content":             file_content
            }).insert(ignore_permissions=True)
        return pe.name
    except Exception as e:
        frappe.log_error("Manual payment entry (booking) failed: " + str(e), "Manual PE Error")
        return None
    finally:
        frappe.set_user(original_user)


def _create_payment_url(customer_name, so_name, amount, booking_number):
    """Cipta Payment Intent (checkout kita sendiri) untuk online payment.
    Redirect selepas bayar dikawal oleh checkout.html -> balik ke wizard step Confirm.
    Status bayaran sebenar ditentukan oleh webhook (stripe_checkout.stripe_webhook),
    bukan redirect ini.
    """
    try:
        from travel_booking.api.stripe_checkout import create_payment_intent
        result = create_payment_intent(
            sales_order=so_name,
            amount=amount,
            source="wizard",
            booking_number=booking_number,
        )
        return result.get("checkout_url", "")
    except Exception as e:
        frappe.log_error("Payment checkout creation failed: " + str(e), "Payment URL Error")
        return ""


# ══════════════════════════════════════════════
# AUTO-INVOICE (per-SO, on fully paid)
# ══════════════════════════════════════════════

def _maybe_auto_invoice_so(so_name):
    """Auto-cipta Sales Invoice untuk SO ni sebaik ia fully paid (per-SO
    independent — TIDAK tunggu SO lain untuk booking yang sama settle
    sekali). Guna mekanisme ERPNext standard 'Get Advances Received' yang
    SAMA dengan yang admin guna manual (rujuk portal_payment.py punya
    nota tentang mekanisme ni) — supaya SEMUA Payment Entry sedia ada
    (deposit + baki, kalau berasingan) betul-betul di-allocate ke invois
    baharu, bukan reka logik allocation sendiri.

    Auto-invoice kegagalan TIDAK patahkan flow payment/booking — dibungkus
    try/except, log error untuk admin siasat/generate manual sebagai
    fallback, sebab bayaran & status booking dah SAH walau invois gagal
    auto-generate.
    """
    so = frappe.db.get_value(
        "Sales Order", so_name,
        ["grand_total", "advance_paid", "docstatus", "currency", "conversion_rate"], as_dict=True
    )
    if not so or so.docstatus != 1:
        return  # SO tak wujud atau belum/tak lagi submitted — tiada apa nak invois

    so_payment_status = _compute_payment_status(so.advance_paid or 0, float(so.grand_total or 0))
    if so_payment_status != "Paid":
        return  # SO ni sendiri belum fully paid — belum masa untuk invois

    # Guard idempotency — SI sedia ada untuk SO ni? PENTING: kecualikan SI
    # yang dah CANCELLED (docstatus=2) — rujuk sesi debug sebenar: kalau
    # admin/proses awal terpaksa cancel SI (cth kesilapan testing, atau
    # refund/pembetulan sebenar), guard ni yang cuma check "SI wujud ke
    # tidak" (tanpa kira docstatus) akan SELAMANYA anggap "dah ada invois"
    # walhal SI tu dah tak sah — auto-invoice takkan PERNAH cuba lagi untuk
    # SO ni, walaupun bayaran baharu masuk kemudian. JOIN ke Sales Invoice
    # induk untuk tapis docstatus (Sales Invoice Item sendiri tiada field
    # docstatus, ia child table).
    existing_si = frappe.db.sql("""
        SELECT sii.parent
        FROM `tabSales Invoice Item` sii
        JOIN `tabSales Invoice` si ON si.name = sii.parent
        WHERE sii.sales_order = %s AND si.docstatus != 2
        LIMIT 1
    """, so_name)
    existing_si = existing_si[0][0] if existing_si else None
    if existing_si:
        return  # dah ada invois SAH (auto atau manual) — jangan buat lagi satu

    try:
        # PENTING: make_sales_invoice() dipindah lokasi dalam ERPNext v17 —
        # dari erpnext.selling.doctype.sales_order.sales_order (lokasi lama,
        # versi sebelumnya) ke erpnext.selling.doctype.sales_order.mapper
        # (refactor ERPNext v17). Import dari lokasi lama akan crash
        # ImportError ("cannot import name 'make_sales_invoice'") — disahkan
        # server dev.rpwp.my jalan ERPNext 17.0.0-dev (rujuk `git describe`/
        # erpnext/__init__.py). Signature fungsi KEKAL SAMA (source_name
        # sebagai parameter pertama), cuma path import yang berubah.
        from erpnext.selling.doctype.sales_order.mapper import make_sales_invoice

        _original_user = frappe.session.user
        frappe.set_user("Administrator")
        try:
            si = make_sales_invoice(so_name)
            si.flags.ignore_permissions = True
            si.set_posting_time = 1
            si.posting_date = frappe.utils.today()

            # PENTING — DIBETULKAN lepas testing sebenar (rujuk sesi debug
            # "Outstanding RM13.17" pada SI SGD yang patut RM0): make_sales_invoice()
            # TAK set 'debit_to' (akaun Receivable) ikut currency SO — ia
            # default ke akaun Debtors syarikat punya currency ASAS (MYR)
            # tak kira apa currency SI sendiri. Ini punca 'party_account_currency'
            # SI (diderive dari debit_to) jadi MYR walhal SI.currency=SGD —
            # MULTI-CURRENCY — DIRINGKASKAN lepas testing sebenar: SI
            # dibiarkan guna akaun Receivable DEFAULT ERPNext (biasanya
            # "Debtors - DC", currency asas company) — TIDAK perlu akaun
            # Receivable berasingan per-currency (yang kita bina & uji
            # sebelum ni) sebab setting Accounts Settings "Allow multi-
            # currency invoices against single party account" (dihidupkan
            # semasa sesi debug) dah selesaikan isu accounting ni di
            # peringkat lebih asas — ERPNext sendiri kendalikan invois
            # currency asing (SGD/dll) terus atas SATU akaun Receivable
            # company currency, tanpa perlu setup akaun berasingan setiap
            # currency baharu. Field 'receivable_account' (Travel Currency
            # Account) kekal dalam schema (backward-compat/opsyenal untuk
            # keperluan masa depan), cuma TAK dibaca/dipakai lagi di sini.

            # "Get Advances Received" — mekanisme ERPNext standard yang
            # SAMA dipanggil bila admin klik butang tu manual. Cari &
            # allocate SEMUA Payment Entry belum-reconcile untuk SO/
            # customer ni secara automatik (deposit + baki, kalau
            # berasingan — SEMUA ditarik, bukan sekadar satu).
            si.set_advances()

            # PENTING — SAHKAN set_advances() betul-betul berjaya, jangan
            # percaya buta. Kalau ia gagal senyap cari Payment Entry yang
            # patut (mismatch party/currency, atau quirk versi ERPNext —
            # rujuk juga isu import path di atas, tanda versi ERPNext boleh
            # berubah tingkah laku), si.advances akan KOSONG/TAK LENGKAP —
            # SI akan submit dengan outstanding PENUH/salah walhal SO ni
            # dah fully paid. Ini bertentangan terus dengan tujuan
            # automation ni ("pastikan dapat advance receives semua") —
            # jadi kita check jumlah allocated PADAN dengan advance_paid SO
            # sebelum benarkan submit. Toleransi RM0.01 untuk floating-
            # point rounding.
            #
            # PENTING JUGA (disahkan via testing sebenar) — ERPNext punya
            # set_advances() (accounts/services/advances.py) TUKAR basis
            # currency allocated_amount ikut party_account_currency SI:
            #   - party_account_currency == company_currency (kes kita
            #     SEKARANG, sejak "Allow multi-currency invoices against
            #     single party account" dihidupkan & kita tak lagi perlukan
            #     receivable_account custom per-currency) -> allocated_amount
            #     dalam COMPANY CURRENCY (MYR), guna base_grand_total.
            #   - party_account_currency != company_currency (kalau admin
            #     override receivable_account currency-specific) ->
            #     allocated_amount dalam SI.currency asal (SGD), guna
            #     grand_total terus.
            # Banding terus so.advance_paid (SENTIASA dalam SO.currency
            # asal, cth SGD) dengan allocated_total tanpa kira basis ni
            # punca "false alarm" mismatch (banding MYR vs SGD terus,
            # bukan pembayaran sebenar tak cukup).
            company_currency = frappe.get_cached_value(
                "Company", si.company, "default_currency"
            )
            allocated_total = sum(float(a.allocated_amount or 0) for a in (si.advances or []))
            if si.get("party_account_currency") == company_currency:
                expected_total = float(so.advance_paid or 0) * float(so.get("conversion_rate") or 1)
            else:
                expected_total = float(so.advance_paid or 0)

            if abs(allocated_total - expected_total) > 0.01:
                frappe.log_error(
                    "Auto-invoice: set_advances() failed to allocate ALL payments "
                    "for SO " + so_name + " — expected " + str(expected_total) +
                    ", but only allocated " + str(allocated_total) + " (basis: " +
                    ("company currency" if si.get("party_account_currency") == company_currency else "SO currency") +
                    "). SI NOT submitted (left as draft/not created) — requires manual "
                    "investigation (check Payment Entry party/currency for this SO) before "
                    "generating the invoice manually.",
                    "Auto Sales Invoice - Advance Mismatch"
                )
                return  # JANGAN submit — biar admin uruskan manual

            si.insert(ignore_permissions=True)
            si.submit()
        finally:
            frappe.set_user(_original_user)

    except Exception as e:
        frappe.log_error(
            "Auto-invoice failed for SO " + so_name + ": " + str(e),
            "Auto Sales Invoice Error"
        )
