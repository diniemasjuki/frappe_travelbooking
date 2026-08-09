# travel_booking/api/portal_payment.py
# Payment & Invoice — Portal (ERPNext-native: Payment Request + Payment Entry)
# ─────────────────────────────────────────────────────────────────────────

import frappe
from travel_booking.api.portal_booking import _get_customer


# ══════════════════════════════════════════════
# GET ALL PAYMENTS (per Sales Order)
# ══════════════════════════════════════════════

@frappe.whitelist()
def get_all_so_payments():
    """Sejarah bayaran customer — baca Payment Entry (bukan RPE) + Sales Invoice.
    SO Cancelled (docstatus=2) TETAP disertakan (transparency di UI, badge
    'Cancelled') tapi dikecualikan dari kiraan Total/Balance di frontend
    (renderMergedBookingCard filters is_cancelled sebelum jumlah).
    """
    frappe.flags.ignore_permissions = True
    customer_name = _get_customer()

    so_rows = frappe.db.sql("""
        SELECT name, grand_total, advance_paid, status, docstatus
        FROM `tabSales Order`
        WHERE customer = %s AND docstatus IN (1, 2)
        ORDER BY creation DESC
    """, customer_name, as_dict=True)

    orders = []
    for so in so_rows:
        so_name = so.name

        # Booking (nama trip sebenar) untuk SO ini — SO boleh jadi SO utama
        # ATAU SO addon (dikaitkan melalui Sales Order.custom_booking), jadi
        # JOIN terus melalui custom_booking (bukan Booking.sales_order yang
        # cuma menyimpan rujukan sehala dari Booking → SO utama).
        bk_rows = frappe.db.sql("""
            SELECT b.name, b.booking_number, tm.trip_name AS trip_label, td.trip_group_name
            FROM `tabSales Order` so
            JOIN `tabBooking` b ON b.name = so.custom_booking
            LEFT JOIN `tabTrip Group Date`   td ON td.name = b.trip_date
            LEFT JOIN `tabTrip` tm ON tm.name = td.trip
            WHERE so.name = %s AND b.customer = %s
        """, (so_name, customer_name), as_dict=True)
        booking_names   = []
        booking_numbers = []
        for b in bk_rows:
            label = b.trip_label or b.name
            if b.trip_group_name:
                label = label + " · " + b.trip_group_name
            booking_names.append(label)
            booking_numbers.append(b.booking_number or b.name)

        # Item lines
        item_rows = frappe.db.sql("""
            SELECT item_name, qty, rate, amount, description
            FROM `tabSales Order Item`
            WHERE parent = %s ORDER BY idx ASC
        """, so_name, as_dict=True)
        items = [{
            "item_name":   r.item_name,
            "description": r.description or "",
            "qty":         r.qty,
            "rate":        float(r.rate),
            "amount":      float(r.amount)
        } for r in item_rows]

        # Payment Entry references ke SO ini (draft + submitted).
        #
        # PENTING: Payment Entry boleh rujuk terus ke Sales Order (kes
        # biasa) ATAU ke Sales Invoice yang dijana DARI SO ni (kes bila
        # admin cipta Sales Invoice secara manual dan guna "Get Advances
        # Received" ERPNext untuk reconcile bayaran sedia ada — mekanisme
        # ni SECARA LITERAL menukar reference_doctype pada Payment Entry
        # Reference dari 'Sales Order' kepada 'Sales Invoice', mengalihkan
        # rujukan Payment Entry YANG SAMA ke dokumen invois baharu).
        # Kalau kita cuma check reference_doctype='Sales Order', payment
        # yang dah "dialihkan" ni akan senyap HILANG dari portal walaupun
        # bayaran tu masih sah — inilah punca "payment history hilang
        # bila dah create Sales Invoice".
        #
        # PENTING JUGA: guna SUM(per.allocated_amount) — BUKAN pe.paid_amount.
        # Admin boleh cipta SATU Payment Entry (dari Desk) yang allocate ke
        # BANYAK Sales Order sekaligus (customer bayar borong beberapa trip
        # dalam satu transaksi bank) — pe.paid_amount ialah jumlah PENUH
        # Payment Entry tu (cth RM15,000 untuk 3 SO), BUKAN jumlah yang
        # betul-betul di-allocate ke SO NI sahaja (cth RM5,000). Guna
        # pe.paid_amount di sini akan papar jumlah PENUH yang mengelirukan
        # pada senarai payment history SETIAP SO (nampak macam overpayment/
        # bayaran salah), walhal advance_paid (jumlah agregat, di bawah)
        # sendiri betul (ERPNext kira allocated_amount dengan tepat).
        # GROUP BY + SUM elakkan double-count kalau satu PE ada >1 baris
        # reference untuk SO/SI yang sama (jarang, tapi selamat).
        pe_rows = frappe.db.sql("""
            SELECT pe.name, SUM(per.allocated_amount) AS allocated_amount,
                   pe.reference_date, pe.mode_of_payment, pe.reference_no,
                   pe.docstatus, pe.creation,
                   CASE pe.docstatus
                     WHEN 1 THEN 'Verified'
                     WHEN 2 THEN 'Cancelled'
                     ELSE 'Pending'
                   END AS status
            FROM `tabPayment Entry` pe
            JOIN `tabPayment Entry Reference` per ON per.parent = pe.name
            WHERE (per.reference_doctype = 'Sales Order' AND per.reference_name = %(so_name)s)
               OR (per.reference_doctype = 'Sales Invoice' AND per.reference_name IN (
                     SELECT DISTINCT sii.parent
                     FROM `tabSales Invoice Item` sii
                     WHERE sii.sales_order = %(so_name)s
                   ))
            GROUP BY pe.name, pe.reference_date, pe.mode_of_payment,
                     pe.reference_no, pe.docstatus, pe.creation
            ORDER BY pe.creation DESC
        """, {"so_name": so_name}, as_dict=True)

        payments = []
        for r in pe_rows:
            proof = frappe.db.get_value(
                "File",
                {"attached_to_doctype": "Payment Entry", "attached_to_name": r.name},
                "file_url"
            ) or ""
            payments.append({
                "name":             r.name,
                "paid_amount":      float(r.allocated_amount or 0),
                "payment_date":     str(r.reference_date) if r.reference_date else "",
                "mode_of_payment":  r.mode_of_payment or "",
                "reference_no":     r.reference_no or "",
                "status":           r.status,
                "docstatus":        r.docstatus,
                "proof_of_payment": proof,
            })

        # Sales Invoice (kalau admin dah generate)
        inv_rows = frappe.db.sql("""
            SELECT DISTINCT sii.parent, si.posting_date,
                   si.grand_total, si.status
            FROM `tabSales Invoice Item` sii
            JOIN `tabSales Invoice` si ON si.name = sii.parent
            WHERE sii.sales_order = %s AND si.docstatus = 1
        """, so_name, as_dict=True)
        invoices = [{
            "name":         r.parent,
            "posting_date": str(r.posting_date) if r.posting_date else "",
            "grand_total":  float(r.grand_total or 0),
            "status":       r.status
        } for r in inv_rows]

        # NOTA: "Disable Rounded Total" kini global (Selling Settings,
        # terpakai untuk Sales Order & Sales Invoice) — standardize ke
        # grand_total sahaja, konsisten dengan create_payment_request()'s
        # outstanding calc.
        effective_total = float(so.grand_total or 0)

        orders.append({
            "name":            so_name,
            "grand_total":     effective_total,
            "advance_paid":    float(so.advance_paid or 0),
            "status":          so.status,
            "is_cancelled":    so.docstatus == 2,
            "bookings":        booking_names,
            "booking_numbers": booking_numbers,
            "items":           items,
            "payments":        payments,
            "invoices":        invoices
        })

    return {"orders": orders}


# ══════════════════════════════════════════════
# CREATE PAYMENT REQUEST (Stripe / online)
# ══════════════════════════════════════════════

@frappe.whitelist()
def create_payment_request(booking_number: str = None, amount: float = None, sales_order: str = None):
    """Cipta Payment Request + Stripe PaymentIntent (checkout.html custom kita
    sendiri, Stripe Elements — BUKAN pr.get_payment_url() ERPNext standard).
    Open amount: min = deposit 20% kalau belum bayar apa-apa, selepas itu bebas; max = baki.

    NOTA PENTING: fungsi ni SEBELUM ini guna pr.get_payment_url() (payment_
    gateway_account diisi terus pada Payment Request) — itu punca checkout
    customer terpapar sebagai halaman hosted-checkout generik "payments" app
    (branding/company salah, contoh "WargaPrihatin"/"None" sebagai title),
    BUKAN checkout.html custom kita dengan Stripe Elements + branding
    Rarecruise. Kini disatukan guna create_payment_intent() (sama fungsi
    yang dipakai wizard booking baru dalam booking.py/_create_payment_url),
    supaya SEMUA online payment (wizard DAN portal per-SO) laluan sama:
    checkout.html + webhook kita sendiri.
    """
    from travel_booking.api.stripe_checkout import create_payment_intent

    frappe.flags.ignore_permissions = True
    customer_name = _get_customer()

    so_name = sales_order
    if not so_name and booking_number:
        from travel_booking.api.booking import _get_primary_so
        booking_name_lookup = frappe.db.get_value("Booking", {"booking_number": booking_number}, "name")
        so_name = _get_primary_so(booking_name_lookup) if booking_name_lookup else None
    if not so_name:
        frappe.throw("Sales Order tidak ditemui untuk booking ini.")

    # Derive booking_number dari SO (arah SEBALIKNYA) kalau caller cuma
    # hantar sales_order sahaja (macam portal_payment.js — klik "Pay Now"
    # pada kad SO individu cuma hantar {sales_order, amount}, tiada
    # booking_number terus). Tanpa ni, metadata PaymentIntent Stripe
    # ("booking_number") kekal KOSONG, dan get_payment_result() (dipanggil
    # selepas redirect balik dari Stripe) gagal padankan balik ke Booking —
    # customer nampak "Couldn't confirm payment status" walaupun bayaran
    # itu sendiri (Stripe) berjaya/gagal seperti biasa.
    if not booking_number:
        booking_name_from_so = frappe.db.get_value("Sales Order", so_name, "custom_booking")
        if booking_name_from_so:
            booking_number = frappe.db.get_value("Booking", booking_name_from_so, "booking_number")

    so = frappe.db.get_value("Sales Order", so_name,
                             ["customer", "grand_total", "advance_paid", "currency"], as_dict=True)
    if so.customer != customer_name:
        frappe.throw("Akses ditolak.", frappe.PermissionError)

    # NOTA: "Disable Rounded Total" kini global (Selling Settings) — semua
    # SO tak lagi ada rounded_total berlainan dari grand_total (dan ERPNext
    # punya validate_payment_request_amount() turut fallback ke grand_total
    # secara automatik di sisi dia untuk SO sebegini). Standardize terus ke
    # grand_total sahaja (rujuk juga nota lengkap di
    # stripe_checkout.create_payment_intent()).
    grand_total = float(so.grand_total or 0)
    paid        = float(so.advance_paid or 0)
    outstanding = grand_total - paid
    if outstanding <= 0:
        frappe.throw("Tiada baki untuk dibayar.")

    req_amount = float(amount) if amount else outstanding

    # Deposit minimum ikut Travel Settings (single-sourced dengan
    # confirm_booking()) — bukan hardcode 20%, supaya konsisten kalau admin
    # tukar peratus deposit lalai.
    settings = frappe.get_cached_doc("Travel Settings")
    default_deposit_percent = float(settings.default_deposit_percent or 20)

    min_amount = round(grand_total * (default_deposit_percent / 100), 2) if paid <= 0 else 1.0
    if req_amount < min_amount - 0.01:
        if paid <= 0:
            frappe.throw("Bayaran pertama mesti sekurang-kurangnya deposit {:.0f}% (RM {:,.2f}).".format(default_deposit_percent, min_amount))
        frappe.throw("Amount tidak sah.")
    if req_amount > outstanding + 0.01:
        frappe.throw("Amount melebihi baki tertunggak (RM {:,.2f}).".format(outstanding))

    result = create_payment_intent(
        sales_order=so_name,
        amount=req_amount,
        source="portal",
        booking_number=booking_number,
    )

    return {
        "status":          result.get("status", "ok"),
        "payment_request":  result.get("payment_request"),
        "amount":          req_amount,
        "min_amount":      min_amount,
        "outstanding":     outstanding,
        "payment_url":     result.get("checkout_url", ""),
        "message":         "Sila teruskan ke pembayaran.",
    }

# ══════════════════════════════════════════════
# SUBMIT MANUAL PAYMENT (customer upload bukti)
# ══════════════════════════════════════════════

@frappe.whitelist()
def submit_manual_payment(amount: float, payment_date: str,
                          reference_no: str, notes: str, filedata: str, filename: str,
                          sales_order: str = None, booking_number: str = None):
    """Manual transfer — cipta Payment Entry DRAFT + attach bukti.

    PENTING: TIDAK set mode_of_payment — field ni Link ke doctype master
    "Mode of Payment" (bukan teks bebas), jadi nilai yang dihantar mesti
    sepadan TEPAT dengan rekod sebenar di Desk (Cash/Bank Draft/dsb),
    kalau tidak pe.insert() throw LinkValidationError. Untuk booking
    system ni, Manual Transfer SENTIASA bermaksud bank transfer sahaja
    (tiada pilihan lain ditawarkan pun di wizard booking pertama —
    rujuk _create_manual_payment_entry() dalam booking.py, yang turut
    TIDAK set field ni langsung dan berfungsi baik) — jadi field pilihan
    "Payment method" tidak perlu, cuma tambah risiko error tanpa faedah.
    """
    import base64
    from erpnext.accounts.party import get_party_account

    # --- Verify customer DULU (keselamatan) ---
    customer_name = _get_customer()

    target_so = sales_order
    if not target_so and booking_number:
        from travel_booking.api.booking import _get_primary_so
        booking_name_lookup = frappe.db.get_value("Booking", {"booking_number": booking_number}, "name")
        target_so = _get_primary_so(booking_name_lookup) if booking_name_lookup else None
    if not target_so:
        frappe.throw("Sales Order tidak ditemui.")

    so = frappe.db.get_value("Sales Order", target_so,
                             ["customer", "company", "currency"], as_dict=True)
    if so.customer != customer_name:
        frappe.throw("Akses ditolak.", frappe.PermissionError)

    # --- Naikkan hak ke sistem untuk cipta Payment Entry ---
    # (customer dah verified atas; dokumen kewangan dicipta dgn hak sistem)
    original_user = frappe.session.user
    frappe.set_user("Administrator")
    try:
        company = so.company or frappe.db.get_single_value("Global Defaults", "default_company")

        # PENTING: guna Travel Settings.manual_transfer_paid_to_account
        # (configurable di Desk) kalau admin dah tetapkan — sama fix
        # dengan _create_manual_payment_entry() (api/booking.py), elak
        # bergantung pada "Account jenis Bank PERTAMA yang jumpa".
        paid_to = frappe.db.get_single_value("Travel Settings", "manual_transfer_paid_to_account")
        if not paid_to:
            paid_to = frappe.db.get_value(
                "Account",
                {"account_type": "Bank", "company": company, "is_group": 0},
                "name"
            )
        party_account = get_party_account("Customer", customer_name, company)

        pe = frappe.new_doc("Payment Entry")
        pe.payment_type    = "Receive"
        pe.company         = company
        pe.posting_date    = payment_date or frappe.utils.today()
        pe.party_type      = "Customer"
        pe.party           = customer_name
        pe.party_account   = party_account
        pe.paid_from       = party_account
        pe.paid_to         = paid_to
        pe.paid_amount     = float(amount)
        pe.received_amount = float(amount)
        pe.reference_no    = reference_no or target_so
        pe.reference_date  = payment_date or frappe.utils.today()

        pe.append("references", {
            "reference_doctype": "Sales Order",
            "reference_name":    target_so,
            "allocated_amount":  float(amount),
        })

        pe.remarks = notes or ("Manual transfer untuk " + target_so + ". Pending verification.")
        pe.insert(ignore_permissions=True)   # draft

        if filedata and filename:
            if "," in filedata:
                filedata = filedata.split(",")[1]
            file_content = base64.b64decode(filedata)
            frappe.get_doc({
                "doctype":             "File",
                "file_name":           filename,
                "attached_to_doctype": "Payment Entry",
                "attached_to_name":    pe.name,
                "is_private":          1,
                "content":             file_content
            }).insert(ignore_permissions=True)

        frappe.db.commit()
        pe_name = pe.name
    finally:
        frappe.set_user(original_user)   # pulang balik ke user asal

    return {
        "status":     "ok",
        "submission": pe_name,
        "message":    "Bukti bayaran diterima. Admin akan verify dalam masa terdekat."
    }


# ══════════════════════════════════════════════
# DOWNLOAD DOCUMENT PDF
# ══════════════════════════════════════════════

PRINT_FORMAT_RECEIPT = "Rarecation Receipt"
PRINT_FORMAT_INVOICE = "Rarecation Invoice"


@frappe.whitelist()
def get_document_pdf(doctype: str, docname: str):
    frappe.flags.ignore_permissions = True
    customer_name = _get_customer()

    if doctype == "Payment Entry":
        pe = frappe.db.sql("""
            SELECT pe.name
            FROM `tabPayment Entry` pe
            WHERE pe.name = %s AND pe.party = %s AND pe.docstatus = 1
        """, (docname, customer_name), as_dict=True)
        if not pe:
            frappe.response["http_status_code"] = 403
            return {"status": "error", "message": "Dokumen tidak dijumpai."}
        print_format = PRINT_FORMAT_RECEIPT

    elif doctype == "Sales Invoice":
        inv = frappe.db.sql("""
            SELECT DISTINCT si.name
            FROM `tabSales Invoice` si
            JOIN `tabSales Invoice Item` sii ON sii.parent = si.name
            JOIN `tabSales Order` so ON so.name = sii.sales_order
            WHERE si.name = %s AND so.customer = %s AND si.docstatus = 1
        """, (docname, customer_name), as_dict=True)
        if not inv:
            frappe.response["http_status_code"] = 403
            return {"status": "error", "message": "Dokumen tidak dijumpai."}
        print_format = PRINT_FORMAT_INVOICE
    else:
        frappe.response["http_status_code"] = 400
        return {"status": "error", "message": "Jenis dokumen tidak sah."}

    try:
        pf = frappe.db.get_value(
            "Print Format", print_format,
            ["html", "custom_format"], as_dict=True
        )
        if not pf or not pf.get("html"):
            frappe.response["http_status_code"] = 404
            return {"status": "error", "message": "Print format tidak dijumpai."}

        doc       = frappe.get_doc(doctype, docname)
        html      = frappe.render_template(pf["html"], {"doc": doc, "frappe": frappe})
        full_html = ("""<!DOCTYPE html><html><head>
<meta charset="utf-8">
<style>@page{margin:0}body{margin:0;padding:0}</style>
</head><body>""" + html + """</body></html>""")

        pdf_data = frappe.utils.pdf.get_pdf(full_html)
    except Exception:
        frappe.log_error(frappe.get_traceback(), "get_document_pdf error")
        frappe.response["http_status_code"] = 500
        return {"status": "error", "message": "PDF tidak dapat dijana."}

    frappe.response.update({
        "filename":     docname.replace("/", "-") + ".pdf",
        "filecontent":  pdf_data,
        "type":         "download",
        "content_type": "application/pdf"
    })