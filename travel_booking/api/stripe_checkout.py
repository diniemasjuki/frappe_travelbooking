# travel_booking/api/stripe_checkout.py
#
# Custom Stripe checkout — kita kawal UI (checkout.html) + redirect penuh.
# Payment Request tetap dicipta (untuk rekod + guna semula method set_as_paid
# yang sedia ada), tapi bayaran sebenar diproses terus dengan Stripe API
# (PaymentIntent) supaya kita boleh bina halaman checkout sendiri.
#
# SUMBER KEBENARAN status bayaran = WEBHOOK (server-to-server), BUKAN redirect
# browser. Redirect cuma untuk UX (bawa customer balik ke halaman betul).

import frappe
import stripe

from travel_booking.api._helpers import get_customer_email


def _get_stripe_settings(currency="MYR"):
    """Cari Payment Gateway Account + Stripe Settings untuk currency ini.

    TEST vs LIVE: boleh wujud LEBIH DARI SATU Payment Gateway Account untuk
    currency yang sama (cth satu live, satu test/sandbox) — admin switch
    antara keduanya semata-mata dengan tukar checkbox "Is Default" di Desk,
    TANPA perlu ubah code ini. Kalau tepat SATU rekod bertanda is_default=1
    untuk currency ni, itu yang diguna. Kalau BUKAN tepat satu (kosong atau
    lebih dari satu — dua-dua kes ini admin misconfiguration), kita throw
    error yang jelas dan TIDAK cuba teka sembarangan yang mana nak diguna —
    memilih secara senyap boleh punca customer live tercaj ke akaun test,
    atau sebaliknya.
    """
    gateway_accounts = frappe.db.sql("""
        SELECT pga.name, pga.payment_gateway, pga.is_default, pg.gateway_controller
        FROM `tabPayment Gateway Account` pga
        JOIN `tabPayment Gateway` pg ON pg.name = pga.payment_gateway
        WHERE pga.currency = %(currency)s
          AND pg.gateway_settings = 'Stripe Settings'
    """, {"currency": currency}, as_dict=True)

    if not gateway_accounts:
        frappe.throw("Payment Gateway untuk " + currency + " tidak dikonfigurasikan. Sila hubungi admin.")

    default_accounts = [g for g in gateway_accounts if g.is_default]

    if len(gateway_accounts) == 1:
        # Hanya satu rekod wujud (kes biasa, tiada test/live berasingan) —
        # guna terus, tak kira status is_default (elak throw tak perlu untuk
        # setup ringkas yang admin tak pernah tandakan default secara eksplisit).
        gateway_account = gateway_accounts[0]
    elif len(default_accounts) == 1:
        gateway_account = default_accounts[0]
    elif len(default_accounts) == 0:
        frappe.throw(
            "Terdapat " + str(len(gateway_accounts)) + " Payment Gateway Account untuk " +
            currency + " tetapi TIADA satu pun ditandakan sebagai 'Is Default'. " +
            "Sila tandakan satu (test ATAU live) sebagai default di Desk > Payment Gateway Account."
        )
    else:
        frappe.throw(
            "Terdapat " + str(len(default_accounts)) + " Payment Gateway Account untuk " +
            currency + " yang ditandakan 'Is Default' serentak (patut cuma SATU). " +
            "Sila padam duplicate default di Desk > Payment Gateway Account."
        )

    settings_name = gateway_account.gateway_controller

    if not settings_name or not frappe.db.exists("Stripe Settings", settings_name):
        frappe.throw("Stripe Settings '" + str(settings_name) + "' tidak dijumpai. Sila hubungi admin.")

    ss = frappe.get_doc("Stripe Settings", settings_name)
    return ss, gateway_account


@frappe.whitelist()
def create_payment_intent(sales_order: str, amount: float, source: str = "portal", booking_number: str = None, pr_amount: float = None):
    """Cipta Payment Request (rekod) + Stripe Payment Intent (bayaran sebenar).
    source: "wizard" (booking baru, guest) atau "portal" (customer login).
    Pulangkan info untuk checkout.html render Stripe Elements.

    'amount' = jumlah SEBENAR PaymentIntent Stripe (apa yang customer bayar
    dalam SATU transaksi kad).
    'pr_amount' (opsyenal) = jumlah untuk Payment Request ERPNext SAHAJA,
    di-cap kepada baki SO ni sendiri. Kalau tak diberi, default = amount.
    Payment Request TIDAK BOLEH melebihi baki SO rujukannya (ERPNext core
    validate_payment_request_amount() throw kalau begitu).

    PENTING — rounded_total vs grand_total: ERPNext punya
    validate_payment_request_amount() (via get_amount() dalam
    payment_request.py) bandingkan jumlah Payment Request terhadap
    "rounded_total ATAU grand_total" SO — rounded_total DIUTAMAKAN bila ia
    bukan sifar/kosong. Bila tetapan "Disable Rounded Total" TIDAK
    dihidupkan, ERPNext bundarkan grand_total (cth RM 5.49) ke integer
    terdekat untuk rounded_total (cth RM 5.00) — dua nilai ni BOLEH
    berbeza. Kalau kita cap pr_amount ikut grand_total sahaja (5.49) tapi
    ERPNext sendiri bandingkan terhadap rounded_total (5.00), throw
    "Total Payment Request amount cannot be greater than Sales Order
    amount" walaupun dari sudut kita amount tu sah. Kita kena guna
    rounded_total SEBAGAI BAKI RUJUKAN bila ia wujud — sama macam ERPNext
    sendiri buat — supaya pr_amount kita padan 100% dengan apa yang
    validate_payment_request_amount() akan terima.
    """
    so = frappe.db.get_value("Sales Order", sales_order,
                             ["customer", "currency", "grand_total", "rounded_total", "advance_paid"], as_dict=True)
    if not so:
        frappe.throw("Sales Order tidak ditemui.")

    amount = float(amount)
    if amount <= 0:
        frappe.throw("Amount tidak sah.")

    # Baki rujukan SEBENAR ikut logik ERPNext (rounded_total diutamakan bila
    # bukan sifar, fallback grand_total) — bukan grand_total semata-mata.
    effective_so_total = float(so.rounded_total or so.grand_total or 0)
    outstanding = round(effective_so_total - float(so.advance_paid or 0), 2)

    # PENTING: kalau 'amount' (jumlah SEBENAR caj Stripe) dikira caller
    # daripada grand_total mentah untuk full payment (cth booking.py's
    # confirm_booking guna so.grand_total terus), ia boleh sedikit LEBIH
    # TINGGI dari rounded_total (cth 5.49 vs 5.00). Kalau kita biarkan,
    # customer akan dicaj kad RM 5.49 tapi Payment Request/Payment Entry
    # ERPNext cuma boleh rekod RM 5.00 (dicap di bawah) — mismatch RM 0.49
    # antara apa yang keluar dari akaun customer dan apa yang tercatat
    # dalam sistem. Kita selaraskan 'amount' SEKALI dengan pr_amount di
    # bawah bila ia jelas untuk full-payment SO yang sama (amount dalam
    # jarak dekat dengan grand_total mentah, tapi melebihi baki sebenar) —
    # supaya caj kad dan rekod ERPNext SENTIASA padan.
    if amount > outstanding + 0.01 and abs(amount - float(so.grand_total or 0)) < 0.01:
        amount = max(outstanding, 0)
        if amount <= 0:
            frappe.throw("Tiada baki untuk dibayar pada Sales Order ini.")

    pr_amount = float(pr_amount) if pr_amount is not None else amount
    if pr_amount <= 0:
        frappe.throw("Amount tidak sah.")

    # Cap pr_amount ke baki SEBENAR (bukan grand_total mentah) — elak
    # validate_payment_request_amount() throw disebabkan pr_amount kita
    # sedikit melebihi rounded_total walaupun secara logik ia sepatutnya sah
    # (cth grand_total RM 5.49 dengan rounded_total RM 5.00 — pr_amount
    # yang cuba dihantar RM 5.49 akan ditolak ERPNext, RM 5.00 diterima).
    if pr_amount > outstanding + 0.01:
        pr_amount = max(outstanding, 0)
    if pr_amount <= 0:
        frappe.throw("Tiada baki untuk dibayar pada Sales Order ini.")

    currency = so.currency or "MYR"
    ss, gateway_account = _get_stripe_settings(currency)

    email = get_customer_email(so.customer)

    # PENTING: buang dulu Payment Request LAMA (submitted, docstatus=1) untuk
    # SO ini yang belum "Paid" — cth dari percubaan bayar sebelum ini yang
    # gagal/ditinggalkan tanpa selesai. ERPNext core
    # (get_existing_payment_request_amount) MENGUMPUL jumlah SEMUA Payment
    # Request submitted untuk SO yang sama (tak kira status), dan
    # validate_payment_request_amount() throw "Total Payment Request amount
    # cannot be greater than Sales Order amount" bila jumlah terkumpul tu
    # (+ request baru) melebihi baki SO — walaupun request baru sendiri sah.
    old_prs = frappe.get_all(
        "Payment Request",
        filters={
            "reference_doctype": "Sales Order",
            "reference_name":    sales_order,
            "docstatus":         1,
            "status":            ["!=", "Paid"],
        },
        pluck="name",
    )
    for old_pr_name in old_prs:
        try:
            old_pr = frappe.get_doc("Payment Request", old_pr_name)
            old_pr.flags.ignore_permissions = True
            old_pr.cancel()
        except Exception as e:
            frappe.log_error(
                "Gagal cancel Payment Request lama " + old_pr_name + " untuk " + sales_order + ": " + str(e),
                "Payment Request Cleanup Error"
            )

    # Payment Request — rekod + guna semula method set_as_paid (ERPNext core)
    # yang dicetuskan oleh webhook selepas bayaran disahkan Stripe.
    # PENTING: payment_gateway_account SENGAJA tidak diisi.
    # Payment Request ini cuma rekod + kenderaan untuk set_as_paid() via webhook —
    # kita TAK guna pr.get_payment_url() (checkout.html + Stripe PaymentIntent kita
    # sendiri yang jana URL bayaran). Kalau payment_gateway_account diisi, ERPNext
    # cuba resolve payment gateway controller semasa submit() (before_submit ->
    # set_payment_request_url() -> get_payment_url()) — laluan ini rapuh terhadap
    # ketidakserasian versi antara app 'payments' dan 'erpnext', dan tiada exception
    # handling yang lengkap di situ. Dengan payment_gateway_account kosong, syarat
    # "if self.payment_account and self.payment_gateway" jadi False, laluan tu
    # terus dilangkau — submit() jadi selamat sepenuhnya.
    #
    # grand_total guna pr_amount (dicap ke baki SO ni), BUKAN amount penuh —
    # kalau tidak validate_payment_request_amount() akan throw untuk booking
    # gabungan di mana amount penuh > baki SO tunggal ni.
    pr = frappe.get_doc({
        "doctype":                 "Payment Request",
        "payment_request_type":    "Inward",
        "party_type":              "Customer",
        "party":                   so.customer,
        "reference_doctype":       "Sales Order",
        "reference_name":          sales_order,
        "grand_total":             pr_amount,
        "currency":                currency,
        "email_to":                email or "",
        "mute_email":              1,
    })
    pr.insert(ignore_permissions=True)
    pr.submit()

    stripe.api_key = ss.get_password("secret_key")

    intent = stripe.PaymentIntent.create(
        amount=int(round(amount * 100)),
        currency=currency.lower(),
        receipt_email=email or None,
        description="Rarecruise Payment — " + sales_order,
        metadata={
            "payment_request": pr.name,
            "sales_order":     sales_order,
            "source":          source,
            "booking_number":  booking_number or "",
        },
    )

    # PENTING: simpan pautan pr.name -> intent.id secara EKSPLISIT dalam cache.
    # Payment Request document di Frappe boleh DIPADAM (bukan sekadar
    # dibatalkan) — bila itu berlaku, nombor siri autoname (cth
    # "ACC/PRQ/2026/00037") akan DIGUNA SEMULA oleh Payment Request
    # BAHARU yang lain pada masa depan. Tapi Stripe metadata "payment_request"
    # pada PaymentIntent LAMA kekal menyimpan nombor siri yang sama — jadi
    # stripe.PaymentIntent.search(query="metadata['payment_request']:'X'")
    # boleh pulangkan BERBILANG PaymentIntent dari sesi/booking yang
    # LANGSUNG TAK BERKAITAN (nombor PR sama tapi document sebenar berbeza),
    # dan carian tu tiada jaminan susunan ikut tarikh terkini dahulu —
    # get_checkout_context() boleh terambil intent LAMA yang salah (amount
    # salah sepenuhnya). Cache ni jadi sumber kebenaran pautan pr -> intent
    # untuk PR SEMASA sahaja (bukan carian metadata yang ambigu merentasi
    # sejarah). TTL 2 jam cukup untuk customer settle checkout.
    frappe.cache().set_value(
        "checkout_intent_" + pr.name,
        intent.id,
        expires_in_sec=7200
    )

    frappe.db.commit()

    checkout_url = frappe.utils.get_url(
        "/checkout?pr=" + pr.name +
        "&src=" + source +
        (("&ref=" + booking_number) if booking_number else "")
    )

    return {
        "status":           "ok",
        "payment_request":  pr.name,
        "checkout_url":     checkout_url,
    }


@frappe.whitelist(allow_guest=True)
def get_checkout_context(pr: str):
    """Dipanggil oleh checkout.html untuk dapatkan client_secret + publishable_key.
    Tak dedah secret_key — hanya client_secret (selamat untuk frontend, ikut design Stripe).
    """
    if not frappe.db.exists("Payment Request", pr):
        frappe.throw("Payment request tidak ditemui.")

    pr_doc = frappe.get_doc("Payment Request", pr)
    if pr_doc.status == "Paid":
        return {"status": "already_paid"}

    so = frappe.db.get_value("Sales Order", pr_doc.reference_name, "currency")
    ss, _ = _get_stripe_settings(so or "MYR")
    stripe.api_key = ss.get_password("secret_key")

    # PENTING: cari Payment Intent EKSAK guna cache pr.name -> intent.id yang
    # disimpan di create_payment_intent() (SUMBER KEBENARAN). TIDAK guna
    # stripe.PaymentIntent.search() lagi sebagai laluan utama — nombor siri
    # autoname Payment Request (cth "ACC/PRQ/2026/00037") boleh DIGUNA SEMULA
    # oleh Frappe selepas document lama dipadam, tapi metadata Stripe pada
    # PaymentIntent LAMA (dari booking/sesi lain yang langsung tak berkaitan)
    # kekal ada nombor PR yang sama — search() query metadata boleh pulangkan
    # >1 hasil merentasi sejarah yang tak berkaitan, tanpa jaminan susunan
    # ikut tarikh, dan get_checkout_context() boleh terambil intent SALAH
    # (amount lapuk dari booking lama). Cache ni elak isu tu sepenuhnya.
    intent = None
    cached_intent_id = frappe.cache().get_value("checkout_intent_" + pr)
    if cached_intent_id:
        try:
            candidate = stripe.PaymentIntent.retrieve(cached_intent_id)
            # Sahkan intent ni betul-betul untuk PR ini (double-check metadata,
            # bukan sekadar percaya cache buta) sebelum guna.
            if (candidate.metadata or {}).get("payment_request") == pr:
                intent = candidate
        except Exception:
            intent = None

    if not intent:
        # Fallback: cache miss/expired (cth checkout.html dibuka lama selepas
        # PaymentIntent dicipta). search() masih boleh silap dalam kes yang
        # sangat jarang (PR name recycled + cache dah expired serentak), tapi
        # ini jauh lebih baik daripada laluan utama sentiasa guna search().
        intents = stripe.PaymentIntent.search(
            query="metadata['payment_request']:'" + pr + "'"
        )
        if intents and intents.data:
            intent = intents.data[0]
        else:
            intent = stripe.PaymentIntent.create(
                amount=int(round(float(pr_doc.grand_total) * 100)),
                currency=(pr_doc.currency or "MYR").lower(),
                metadata={"payment_request": pr, "sales_order": pr_doc.reference_name},
            )
        frappe.cache().set_value("checkout_intent_" + pr, intent.id, expires_in_sec=7200)

    # PENTING: amount dipulangkan dari intent.amount (Stripe PaymentIntent
    # SEBENAR), BUKAN pr_doc.grand_total. pr_amount (di create_payment_intent())
    # boleh mengecapkan Payment Request ERPNext kepada baki SO tunggal supaya
    # lulus validate_payment_request_amount(), tapi PaymentIntent Stripe tetap
    # guna 'amount' PENUH yang customer sebenarnya bayar. pr_doc.grand_total
    # di sini boleh jadi lebih kecil dari yang customer patut dicaj — jangan
    # guna untuk paparan.
    return {
        "status":           "ok",
        "client_secret":    intent.client_secret,
        "publishable_key":  ss.publishable_key,
        "amount":           float(intent.amount) / 100.0,
        "currency":         pr_doc.currency or "MYR",
    }


@frappe.whitelist(allow_guest=True)
def mark_checkout_timeout(pr: str):
    """Dipanggil oleh checkout.html bila countdown 5 minit tamat tanpa
    bayaran berjaya (customer tinggal page tu terbuka, tak siapkan bayaran).
    Hantar emel "Pending" (kalau belum) supaya customer dapat pautan untuk
    sambung bayaran dari portal kemudian. Idempotent — kalau booking dah
    "Accepted"/lebih (cth bayaran sempat berjaya serentak), tak buat apa-apa.
    Tak sentuh Payment Request/PaymentIntent Stripe — ia kekal, akan
    digantikan automatik bila customer cuba bayar semula dari portal.
    """
    if not pr or not frappe.db.exists("Payment Request", pr):
        return {"status": "ignored"}

    pr_doc = frappe.db.get_value("Payment Request", pr, "reference_name")
    if not pr_doc:
        return {"status": "ignored"}

    booking_name = frappe.db.get_value("Sales Order", pr_doc, "custom_booking")
    if not booking_name:
        return {"status": "ignored"}

    status = frappe.db.get_value("Booking", booking_name, "status")
    if status != "Pending":
        return {"status": "ignored"}

    from travel_booking.api.booking import _send_status_email
    _send_status_email(booking_name, "Pending")
    return {"status": "ok"}


@frappe.whitelist(allow_guest=True, methods=["POST"])
def stripe_webhook():
    """Endpoint webhook Stripe — SUMBER KEBENARAN status bayaran.
    Berjalan server-to-server; tak bergantung pada redirect browser.

    NOTA test vs live: Stripe bagi SECRET BERBEZA untuk setiap webhook
    endpoint didaftar (Developers > Webhooks) — walaupun URL destinasi
    yang sama digunakan untuk kedua-dua mod Test dan Live. Jadi endpoint
    ini boleh terima event yang ditandatangan dengan salah SATU daripada
    dua secret berbeza. Kita simpan kedua-duanya dalam site_config.json
    (site_config['stripe_webhook_secret'] untuk live — key asal, dikekalkan
    untuk backward-compat — dan site_config['stripe_webhook_secret_test']
    untuk test, opsyenal) dan CUBA verify dengan setiap satu sehingga
    berjaya. Ini elak keperluan tukar site_config.json setiap kali admin
    switch antara test/live di Payment Gateway Account.
    """
    payload    = frappe.request.data
    sig_header = frappe.request.headers.get("Stripe-Signature")

    webhook_secrets = [
        s for s in [
            frappe.conf.get("stripe_webhook_secret"),
            frappe.conf.get("stripe_webhook_secret_test"),
        ] if s
    ]

    if not webhook_secrets:
        frappe.log_error("Tiada stripe_webhook_secret / stripe_webhook_secret_test dikonfigurasikan dalam site_config.json",
                         "Stripe Webhook Config Error")
        frappe.local.response.http_status_code = 500
        return {"error": "webhook not configured"}

    event = None
    last_error = None
    for webhook_secret in webhook_secrets:
        try:
            event = stripe.Webhook.construct_event(payload, sig_header, webhook_secret)
            break
        except ValueError as e:
            # Payload tak sah (bukan JSON betul) — TIADA secret akan berjaya
            # verify ni, tak perlu cuba secret lain.
            frappe.log_error("Invalid payload", "Stripe Webhook Error")
            frappe.local.response.http_status_code = 400
            return {"error": "invalid payload"}
        except stripe.error.SignatureVerificationError as e:
            # Signature tak match secret NI — cuba secret seterusnya
            # (mungkin event ni dari mod test, secret ni untuk live, atau
            # sebaliknya) sebelum betul-betul reject.
            last_error = e
            continue

    if event is None:
        frappe.log_error("Invalid signature (cuba " + str(len(webhook_secrets)) + " secret) — " + str(last_error),
                         "Stripe Webhook Error")
        frappe.local.response.http_status_code = 400
        return {"error": "invalid signature"}

    event_type = event.get("type")
    obj = event.get("data", {}).get("object", {})

    if event_type == "payment_intent.succeeded":
        _handle_payment_succeeded(obj)
    elif event_type == "payment_intent.payment_failed":
        _handle_payment_failed(obj)
    # Event lain diabaikan senyap (tak perlu tindakan).

    frappe.local.response.http_status_code = 200
    return {"status": "ok"}


def _handle_payment_succeeded(payment_intent):
    pr_name = (payment_intent.get("metadata") or {}).get("payment_request")
    if not pr_name or not frappe.db.exists("Payment Request", pr_name):
        frappe.log_error("Webhook: payment_request tidak dijumpai dalam metadata. PI: " +
                         str(payment_intent.get("id")), "Stripe Webhook")
        return

    pr = frappe.get_doc("Payment Request", pr_name)
    if pr.status == "Paid":
        return  # idempotent — dah diproses (webhook boleh berulang dari Stripe)

    # Webhook dipanggil server-to-server oleh Stripe — session semasa biasanya
    # Guest (endpoint allow_guest=True), yang TIADA akses baca Account (bank/cash
    # default) yang diperlukan set_as_paid() untuk cipta Payment Entry. Sama
    # pattern macam confirm_booking() — jalankan sebagai Administrator sementara.
    _original_user = frappe.session.user
    frappe.set_user("Administrator")
    try:
        pr.run_method("set_as_paid")
        frappe.db.commit()
    except Exception as e:
        frappe.log_error("set_as_paid gagal untuk " + pr_name + ": " + str(e),
                         "Stripe Webhook - Payment Entry Error")
    finally:
        frappe.set_user(_original_user)


def _handle_payment_failed(payment_intent):
    pr_name = (payment_intent.get("metadata") or {}).get("payment_request")
    frappe.log_error(
        "Payment gagal untuk Payment Request " + str(pr_name) +
        " (PI: " + str(payment_intent.get("id")) + ")",
        "Stripe Payment Failed"
    )
    _notify_booking_pending_if_unpaid(payment_intent)


def _notify_booking_pending_if_unpaid(payment_intent):
    """Dipanggil bila Stripe confirm payment gagal (webhook) ATAU bila
    checkout.html punya timeout 5 minit tercapai tanpa bayaran berjaya
    (lihat mark_checkout_timeout()). Hantar emel "Pending" SEKALI SAHAJA —
    kalau booking dah "Accepted" atau lebih (bayaran lain dah settle
    serentak — cth retry berjaya di tab lain), jangan hantar apa-apa,
    supaya customer tak dapat emel "Pending" selepas "Accepted".
    """
    booking_number = (payment_intent.get("metadata") or {}).get("booking_number")
    if not booking_number:
        return

    booking = frappe.db.get_value("Booking", {"booking_number": booking_number},
                                  ["name", "status"], as_dict=True)
    if not booking or booking.status != "Pending":
        return

    from travel_booking.api.booking import _send_status_email
    _send_status_email(booking.name, "Pending")


@frappe.whitelist(allow_guest=True)
def get_payment_result(payment_intent: str):
    """Dipanggil oleh halaman status bayaran portal (selepas redirect dari
    Stripe) untuk sahkan status SEBENAR bayaran — bukan sekadar percaya
    'redirect_status' dalam URL (Stripe sendiri tak menjamin parameter tu
    rasmi/selamat; ia boleh dipalsukan oleh sesiapa sekadar menukar URL).
    Kita ambil terus dari Stripe API guna 'payment_intent' id (turut
    disertakan Stripe dalam URL selepas redirect), lalu padankan dengan
    Payment Request/Sales Order kita untuk paparan yang boleh dipercayai.
    """
    if not payment_intent:
        frappe.throw("Payment intent tidak ditemui.")

    # payment_intent id tak dedah currency/company terus, jadi cuba MYR dulu
    # (majoriti kes), fallback cuba semua currency Stripe Settings lain kalau
    # gagal — currency sebenar akan disahkan semula lepas retrieve berjaya.
    # NOTA: nama Payment Gateway (cth "Rarecruise") boleh jadi apa-apa label
    # brand — TAK semestinya bermula dengan "Stripe" — jadi kita kenal pasti
    # Payment Gateway Account yang guna Stripe melalui gateway_settings pada
    # Payment Gateway (rujuk juga _get_stripe_settings() di atas), bukan LIKE
    # 'Stripe%' pada nama.
    ss = None
    intent = None
    last_error = None
    other_currencies = frappe.db.sql("""
        SELECT DISTINCT pga.currency
        FROM `tabPayment Gateway Account` pga
        JOIN `tabPayment Gateway` pg ON pg.name = pga.payment_gateway
        WHERE pg.gateway_settings = 'Stripe Settings'
          AND pga.currency != 'MYR'
    """, pluck="currency")
    for currency_guess in ["MYR"] + [c for c in other_currencies if c]:
        try:
            ss, _ = _get_stripe_settings(currency_guess)
            stripe.api_key = ss.get_password("secret_key")
            intent = stripe.PaymentIntent.retrieve(payment_intent)
            break
        except Exception as e:
            last_error = str(e)
            continue

    if not intent:
        # PENTING: log sebab sebenar kegagalan (bukan telan senyap) — supaya
        # admin boleh diagnos kenapa get_payment_result gagal walaupun
        # webhook Stripe sendiri dah berjaya proses PaymentIntent yang sama.
        frappe.log_error(
            "get_payment_result gagal retrieve intent " + str(payment_intent) +
            ". Last error: " + str(last_error),
            "Payment Result Lookup Error"
        )
        return {
            "status": "unknown",
            "message": "Payment tidak dapat disahkan. Sila semak dalam Transactions atau hubungi admin.",
        }

    pr_name = (intent.metadata or {}).get("payment_request")
    so_name = (intent.metadata or {}).get("sales_order")
    booking_number = (intent.metadata or {}).get("booking_number") or ""

    trip_label = ""
    if so_name:
        bk = frappe.db.sql("""
            SELECT tm.trip_name AS trip_label, td.trip_group_name
            FROM `tabSales Order` so
            JOIN `tabBooking` b ON b.name = so.custom_booking
            LEFT JOIN `tabTrip Group Date`   td ON td.name = b.trip_date
            LEFT JOIN `tabTrip` tm ON tm.name = td.trip
            WHERE so.name = %s
            LIMIT 1
        """, so_name, as_dict=True)
        if bk:
            trip_label = bk[0].trip_label or ""
            if bk[0].trip_group_name:
                trip_label = trip_label + " · " + bk[0].trip_group_name

    pr_status = frappe.db.get_value("Payment Request", pr_name, "status") if pr_name else None

    # Stripe intent.status ialah SUMBER KEBENARAN sebenar (bukan redirect_status
    # URL). 'succeeded' = bayaran berjaya; 'processing' = masih diproses
    # (jarang untuk kad, biasa untuk kaedah bank tempatan); selainnya = gagal.
    if intent.status == "succeeded":
        result_status = "succeeded"
    elif intent.status == "processing":
        result_status = "processing"
    else:
        result_status = "failed"

    return {
        "status":          result_status,
        "amount":          float(intent.amount) / 100.0,
        "currency":        (intent.currency or "myr").upper(),
        "sales_order":     so_name or "",
        "trip_label":      trip_label,
        "booking_number":  booking_number,
        "payment_request": pr_name or "",
        "pr_verified":     pr_status == "Paid",
        "last_error":      (intent.last_payment_error or {}).get("message") if result_status == "failed" else "",
    }