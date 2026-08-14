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


def _rate_limit(scope, max_requests, window_sec):
    """Rate limiting generik per-IP guna Redis cache (frappe.cache()).

    Pulangkan True kalau request ini DIBENARKAN (bawah had), False kalau
    dah melebihi had (caller patut frappe.throw atau return ignored).

    Corak ni sama dengan send_otp() di otp.py — key berasaskan scope + IP,
    counter + TTL eksplisit (bukan bergantung pada tingkah laku Redis SET
    yang tak jelas didokumenkan untuk TTL retention).
    """
    client_ip = frappe.local.request_ip or "unknown"
    key = "rate_" + scope + "_" + client_ip
    count = frappe.cache().get_value(key)
    if count and int(count) >= max_requests:
        return False
    frappe.cache().set_value(key, str(int(count or 0) + 1), expires_in_sec=window_sec)
    return True


def _get_stripe_settings(currency=None):
    """Selesaikan Stripe Settings (publishable_key/secret_key/webhook signing
    secret) + Payment Gateway Account daripada Travel Settings.currency_accounts
    (child table "Travel Currency Account" — satu baris per currency yang
    disokong: MYR, SGD, BND, dsb — rujuk dokumen reka bentuk multi-currency).

    PENTING — "Pilihan A" (satu akaun Stripe untuk SEMUA currency, bukan
    banyak Stripe Settings berasingan): setiap baris currency_accounts
    ada payment_gateway_account SENDIRI (untuk payment_account/ledger
    perakaunan yang betul ikut currency), tapi SEMUA baris tu sepatutnya
    berkongsi Payment Gateway (dan Stripe Settings — API key/webhook
    secret) yang SAMA. Jadi:

    - currency DIBEKALKAN (cth create_payment_intent, perlukan ledger
      account yang TEPAT untuk currency SO tu) -> cari baris currency_accounts
      yang currency-nya PADAN.
    - currency TIADA dibekalkan (webhook, checkout context, payment result
      — semua tempat yang cuma perlukan API key/webhook secret KONGSI,
      bukan ledger account spesifik) -> guna baris PERTAMA yang ada
      payment_gateway_account (mana-mana pun sepatutnya beri Stripe
      Settings yang SAMA, sebab kongsi Payment Gateway).

    Rantaian resolusi (sama macam sebelum ni, cuma sumber gateway_account
    sekarang dari child table, bukan field payment_gateway tunggal):
      Travel Settings.currency_accounts[i].payment_gateway_account
        -> Payment Gateway Account.payment_gateway  (Link -> Payment Gateway)
          -> Payment Gateway.gateway_controller      (nama Stripe Settings)
            -> Stripe Settings (publishable_key / secret_key /
                                 custom_webhook_signing_secret)

    Tambah currency baharu = tambah baris baharu di Travel Settings (Desk),
    TIADA keperluan code/deploy — konsisten dengan keperluan "reka bentuk
    sebarang currency" (bukan hardcode SGD/BND).
    """
    settings = frappe.get_cached_doc("Travel Settings")
    rows = settings.get("currency_accounts") or []
    if not rows:
        frappe.throw(
            "No Currency Account configured in Travel Settings "
            "(under 'Multi Currency Account'). Please contact admin."
        )

    gateway_account_name = None
    if currency:
        for row in rows:
            if row.currency == currency and row.payment_gateway_account:
                gateway_account_name = row.payment_gateway_account
                break
        if not gateway_account_name:
            frappe.throw(
                "No Payment Gateway Account configured for currency '" +
                str(currency) + "' in Travel Settings. Please contact admin."
            )
    else:
        for row in rows:
            if row.payment_gateway_account:
                gateway_account_name = row.payment_gateway_account
                break
        if not gateway_account_name:
            frappe.throw(
                "No Payment Gateway Account configured in any "
                "Currency Account row in Travel Settings. Please contact admin."
            )

    gateway_account = frappe.db.get_value(
        "Payment Gateway Account", gateway_account_name,
        ["name", "payment_gateway", "payment_account"], as_dict=True
    )
    if not gateway_account:
        frappe.throw(
            "Payment Gateway Account '" + str(gateway_account_name) +
            "' (set in Travel Settings) not found. Please contact admin."
        )

    settings_name = frappe.db.get_value(
        "Payment Gateway", gateway_account.payment_gateway, "gateway_controller"
    )
    if not settings_name or not frappe.db.exists("Stripe Settings", settings_name):
        frappe.throw(
            "Stripe Settings for Payment Gateway Account '" + gateway_account_name +
            "' not found. Please contact admin."
        )

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

    NOTA — rounded_total vs grand_total: ERPNext punya
    validate_payment_request_amount() (via get_amount() dalam
    payment_request.py) bandingkan jumlah Payment Request terhadap
    "rounded_total ATAU grand_total" SO — rounded_total DIUTAMAKAN bila ia
    bukan sifar/kosong. "Disable Rounded Total" kini dihidupkan SECARA
    GLOBAL di Selling Settings (bukan setakat per-SO lagi), jadi
    rounded_total SENTIASA 0/kosong untuk semua SO dalam app ni — ERPNext
    sendiri turut fallback ke grand_total secara automatik di sisi dia.
    Kita standardize terus ke grand_total sahaja di sini, konsisten dengan
    apa yang ERPNext core akan banding sebenarnya.
    """
    so = frappe.db.get_value("Sales Order", sales_order,
                             ["customer", "currency", "grand_total", "advance_paid"], as_dict=True)
    if not so:
        frappe.throw("Sales Order not found.")

    amount = float(amount)
    if amount <= 0:
        frappe.throw("Invalid amount.")

    # Baki rujukan — standardize ke grand_total (rujuk nota "Disable
    # Rounded Total" global di atas).
    effective_so_total = float(so.grand_total or 0)
    outstanding = round(effective_so_total - float(so.advance_paid or 0), 2)

    # Jaring keselamatan float precision: 'amount' (jumlah SEBENAR caj
    # Stripe) yang caller kira secara berasingan (cth booking.py's
    # confirm_booking) patut sepadan dengan outstanding grand_total di
    # sini, tapi kita cap balik ke outstanding sebenar kalau ada lebihan
    # kecil (cth ralat float) untuk full-payment SO yang sama — supaya caj
    # kad dan rekod ERPNext SENTIASA padan.
    if amount > outstanding + 0.01 and abs(amount - float(so.grand_total or 0)) < 0.01:
        amount = max(outstanding, 0)
        if amount <= 0:
            frappe.throw("No balance to pay on this Sales Order.")

    pr_amount = float(pr_amount) if pr_amount is not None else amount
    if pr_amount <= 0:
        frappe.throw("Invalid amount.")

    # Cap pr_amount ke baki SEBENAR — elak validate_payment_request_amount()
    # throw disebabkan pr_amount kita sedikit melebihi baki (ralat float).
    if pr_amount > outstanding + 0.01:
        pr_amount = max(outstanding, 0)
    if pr_amount <= 0:
        frappe.throw("No balance to pay on this Sales Order.")

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
                "Failed to cancel old Payment Request " + old_pr_name + " for " + sales_order + ": " + str(e),
                "Payment Request Cleanup Error"
            )

    # Payment Request — rekod + guna semula method set_as_paid (ERPNext core)
    # yang dicetuskan oleh webhook selepas bayaran disahkan Stripe.
    # PENTING: payment_account/payment_gateway SENGAJA tidak diisi semasa
    # INSERT/SUBMIT (rujuk db_set() SELEPAS pr.submit() di bawah untuk
    # bila field ni sebenarnya diisi).
    # Payment Request ini cuma rekod + kenderaan untuk set_as_paid() via webhook —
    # kita TAK guna pr.get_payment_url() (checkout.html + Stripe PaymentIntent kita
    # sendiri yang jana URL bayaran). Kalau payment_account/payment_gateway diisi
    # SEBELUM submit(), ERPNext cuba resolve payment gateway controller semasa
    # submit() (before_submit -> set_payment_request_url() -> get_payment_url()) —
    # laluan ini rapuh terhadap ketidakserasian versi antara app 'payments' dan
    # 'erpnext', dan tiada exception handling yang lengkap di situ. Dengan kedua
    # field ni kosong SEMASA submit(), syarat "if self.payment_account and
    # self.payment_gateway" jadi False, laluan tu terus dilangkau — submit() jadi
    # selamat sepenuhnya. Field diisi SELEPAS submit() (via db_set(), tak
    # re-trigger validate()) supaya set_as_paid() (dipanggil kemudian via webhook)
    # tetap ada rujukan akaun yang betul — tanpa ni, ERPNext fallback ke akaun
    # Cash lalai company bila cipta Payment Entry, bukan akaun Bank/Stripe sebenar.
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

    # PENTING: set payment_account/payment_gateway SELEPAS submit() (guna
    # db_set(), bukan sebelum/semasa insert) — db_set() terus tulis DB,
    # TAK re-trigger validate()/before_submit(), jadi laluan rapuh yang
    # sengaja kita elak (rujuk nota di atas) tetap tak tersentuh. Tanpa
    # ni, set_as_paid() (dipanggil KEMUDIAN via webhook selepas Stripe
    # sahkan bayaran) tiada rujukan akaun yang betul untuk Payment Entry
    # yang ia cipta — ERPNext fallback ke akaun Cash lalai company
    # (punca Payment Entry Online Payment tersalah papar "Cash" sebagai
    # Paid To, bukan akaun Bank/Stripe yang sepatutnya).
    pr.db_set("payment_account", gateway_account.payment_account, update_modified=False)
    pr.db_set("payment_gateway", gateway_account.payment_gateway, update_modified=False)

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
        frappe.throw("Payment request not found.")

    pr_doc = frappe.get_doc("Payment Request", pr)
    if pr_doc.status == "Paid":
        return {"status": "already_paid"}

    ss, _ = _get_stripe_settings()
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
    # Rate limiting per-IP — endpoint ni allow_guest=True, jadi sesiapa boleh
    # panggil. Idempotent memang (booking yang dah Accepted diabaikan), tapi
    # tanpa had kadar, bot boleh flood trigger panggilan DB + email untuk
    # beribu-ribu Payment Request name yang teka. Had 5/minit/IP cukup untuk
    # customer sebenar (satu checkout = satu timeout) tapi cukup ketat untuk
    # block abuse. Corak sama dengan send_otp() di otp.py.
    if not _rate_limit("checkout_timeout", max_requests=5, window_sec=60):
        frappe.throw("Too many requests. Please try again shortly.")

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

    from travel_booking.api.email_service import _send_status_email
    _send_status_email(booking_name, "Pending")
    return {"status": "ok"}


@frappe.whitelist(allow_guest=True, methods=["POST"])
def stripe_webhook():
    """Endpoint webhook Stripe — SUMBER KEBENARAN status bayaran.
    Berjalan server-to-server; tak bergantung pada redirect browser.

    Webhook signing secret dibaca dari Stripe Settings.custom_webhook_signing_secret
    milik SATU akaun yang ditetapkan di Travel Settings.payment_gateway (rujuk
    _get_stripe_settings()) — BUKAN lagi site_config.json. Admin switch akaun
    (test <-> live) semata-mata tukar Travel Settings.payment_gateway di Desk;
    tiada keperluan sentuh site_config.json atau restart bench.
    """
    payload    = frappe.request.data
    sig_header = frappe.request.headers.get("Stripe-Signature")

    ss, _ = _get_stripe_settings()
    webhook_secret = ss.get_password("custom_webhook_signing_secret", raise_exception=False)

    if not webhook_secret:
        frappe.log_error(
            "No Webhook Signing Secret is configured on Stripe Settings '" +
            ss.name + "' (account set in Travel Settings.payment_gateway).",
            "Stripe Webhook Config Error"
        )
        frappe.local.response.http_status_code = 500
        return {"error": "webhook not configured"}

    try:
        event = stripe.Webhook.construct_event(payload, sig_header, webhook_secret)
    except ValueError:
        # Payload tak sah (bukan JSON betul).
        frappe.log_error("Invalid payload", "Stripe Webhook Error")
        frappe.local.response.http_status_code = 400
        return {"error": "invalid payload"}
    except stripe.error.SignatureVerificationError as e:
        frappe.log_error("Invalid signature — " + str(e), "Stripe Webhook Error")
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


def _mark_payment_request_paid(pr_name):
    """Tandakan Payment Request sebagai Paid (cipta Payment Entry via
    set_as_paid()) — idempotent, selamat dipanggil berulang kali.

    Guna DUA laluan berasingan:
      1. Webhook Stripe (_handle_payment_succeeded) — laluan UTAMA/normal.
      2. get_payment_result() sebagai FALLBACK — kalau customer redirect
         balik dan Stripe API sahkan bayaran 'succeeded', tapi Payment
         Request kita MASIH belum 'Paid' (webhook mungkin lambat sampai,
         gagal dihantar Stripe, atau tersekat/gagal diproses server kita
         atas sebab lain). Tanpa fallback ni, customer nampak "Payment
         successful" di skrin tapi booking/SO di sistem kita senyap kekal
         "Pending" — admin tak nampak bayaran ni langsung sehingga
         disedari secara manual.

    Pulangkan True kalau Payment Request itu SEKARANG "Paid" (sama ada
    baru sahaja ditandakan, atau memang dah "Paid" sebelum ni) — False
    kalau gagal/tidak wujud.
    """
    if not pr_name or not frappe.db.exists("Payment Request", pr_name):
        return False

    pr = frappe.get_doc("Payment Request", pr_name)
    if pr.status == "Paid":
        return True  # idempotent — dah diproses (webhook boleh berulang dari Stripe)

    # Guna hak Administrator sementara — Guest/customer session (endpoint
    # allow_guest=True) TIADA akses baca Account (bank/cash default) yang
    # diperlukan set_as_paid() untuk cipta Payment Entry. Sama pattern
    # dengan confirm_booking().
    _original_user = frappe.session.user
    frappe.set_user("Administrator")
    try:
        pr.run_method("set_as_paid")
        frappe.db.commit()
        return True
    except Exception as e:
        frappe.log_error("set_as_paid failed for " + pr_name + ": " + str(e),
                         "Stripe Payment Entry Error")
        return False
    finally:
        frappe.set_user(_original_user)


def _handle_payment_succeeded(payment_intent):
    pr_name = (payment_intent.get("metadata") or {}).get("payment_request")
    if not pr_name or not frappe.db.exists("Payment Request", pr_name):
        frappe.log_error("Webhook: payment_request not found in metadata. PI: " +
                         str(payment_intent.get("id")), "Stripe Webhook")
        return
    _mark_payment_request_paid(pr_name)


def _handle_payment_failed(payment_intent):
    pr_name = (payment_intent.get("metadata") or {}).get("payment_request")
    frappe.log_error(
        "Payment failed for Payment Request " + str(pr_name) +
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

    from travel_booking.api.email_service import _send_status_email
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
    # Rate limiting per-IP — endpoint ni allow_guest=True dan setiap panggilan
    # retrieve PaymentIntent dari Stripe API (network request keluar). Tanpa
    # had, bot boleh flood Stripe API guna payment_intent id yang teka/wujud,
    # buang kuota rate limit Stripe kita + beban server. Had 15/minit/IP
    # longgar cukup untuk customer sebenar (redirect status page mungkin
    # poll beberapa kali), tapi ketat cukup untuk block abuse. Corak sama
    # dengan send_otp() di otp.py.
    if not _rate_limit("payment_result", max_requests=15, window_sec=60):
        frappe.throw("Too many requests. Please try again shortly.")

    if not payment_intent:
        frappe.throw("Payment intent not found.")

    # SATU akaun Stripe sahaja untuk seluruh app (Travel Settings.payment_gateway)
    # — tiada lagi keperluan teka/loop currency untuk cari Stripe Settings yang
    # betul (rujuk _get_stripe_settings() untuk rantaian resolusi penuh).
    try:
        ss, _ = _get_stripe_settings()
        stripe.api_key = ss.get_password("secret_key")
        intent = stripe.PaymentIntent.retrieve(payment_intent)
    except Exception as e:
        # PENTING: log sebab sebenar kegagalan (bukan telan senyap) — supaya
        # admin boleh diagnos kenapa get_payment_result gagal walaupun
        # webhook Stripe sendiri dah berjaya proses PaymentIntent yang sama.
        frappe.log_error(
            "get_payment_result failed to retrieve intent " + str(payment_intent) +
            ". Error: " + str(e),
            "Payment Result Lookup Error"
        )
        return {
            "status": "unknown",
            "message": "Payment could not be verified. Please check under Transactions or contact admin.",
        }

    pr_name = (intent.metadata or {}).get("payment_request")
    so_name = (intent.metadata or {}).get("sales_order")
    booking_number = (intent.metadata or {}).get("booking_number") or ""

    # KESELAMATAN — verify pemilikan: endpoint ni allow_guest=True (Stripe
    # redirect balik bawa payment_intent di URL, customer MUNGKIN belum
    # login lagi selepas redirect). payment_intent id sendiri adalah rahsia
    # Stripe (27-char, tak boleh diteka) — jadi untuk Guest (redirect
    # langsung dari Stripe, sesi mungkin tak hadir selepas redirect cookies
    # tak sync), kita benarkan lookup kerana memiliki id = bukti indirect
    # pemilikan (hanya customer yang memulakan checkout tahu id).
    #
    # TAPI untuk user AUTHENTICATED yang cuba akses payment_intent ORANG
    # LAIN (cth admin/staff yang login, atau customer cuba teka id),
    # kita verify pemilikan via SO.custom_booking -> Booking.customer.
    # Ini elak pengguna yang authenticated "menyiasat" pembayaran customer
    # lain walaupun mereka tak patut nampak.
    user_email = frappe.session.user
    if user_email and user_email != "Guest" and so_name:
        from travel_booking.api._helpers import get_customer_by_email
        owner_customer = get_customer_by_email(user_email)
        so_customer = frappe.db.get_value("Sales Order", so_name, "customer") if frappe.db.exists("Sales Order", so_name) else None
        if owner_customer and so_customer and so_customer != owner_customer:
            frappe.log_error(
                "Access denied in get_payment_result: user {0} (customer={1}) attempted to access "
                "payment_intent {2} belonging to customer={3}".format(
                    user_email, owner_customer, payment_intent, so_customer
                ),
                "Payment Result Access Denied"
            )
            frappe.throw("Access denied.", frappe.PermissionError)

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

    # Stripe intent.status ialah SUMBER KEBENARAN sebenar (bukan redirect_status
    # URL). 'succeeded' = bayaran berjaya; 'processing' = masih diproses
    # (jarang untuk kad, biasa untuk kaedah bank tempatan); selainnya = gagal.
    if intent.status == "succeeded":
        result_status = "succeeded"
    elif intent.status == "processing":
        result_status = "processing"
    else:
        result_status = "failed"

    pr_status = frappe.db.get_value("Payment Request", pr_name, "status") if pr_name else None

    # PENTING — JARING KESELAMATAN untuk webhook yang terlepas/gagal sampai:
    # Stripe sendiri sahkan bayaran 'succeeded', tapi Payment Request kita
    # MASIH belum 'Paid' (webhook lambat, gagal dihantar Stripe, endpoint
    # tersekat, signing secret salah dikonfigurasikan tanpa disedari, dsb).
    # Tanpa semakan ni, customer akan redirect balik dan nampak "Payment
    # successful" di skrin — SEDANGKAN booking/SO di sistem kita senyap
    # kekal "Pending" (tiada Payment Entry, admin tak nampak bayaran ni
    # langsung). Kita panggil set_as_paid() di SINI sebagai fallback —
    # idempotent (rujuk _mark_payment_request_paid()), jadi selamat
    # walaupun webhook SEBENARNYA berjaya diproses serentak/lebih awal.
    if result_status == "succeeded" and pr_name and pr_status != "Paid":
        if _mark_payment_request_paid(pr_name):
            pr_status = "Paid"
        else:
            # set_as_paid() gagal (rujuk Error Log "Stripe Payment Entry
            # Error") — jangan sorok kegagalan ni dari customer/admin.
            # pr_verified akan kekal False dalam response, dan admin
            # nampak error tercatat untuk siasat manual.
            frappe.log_error(
                "get_payment_result: Stripe confirmed 'succeeded' for PI " +
                str(payment_intent) + " but set_as_paid() fallback FAILED " +
                "for Payment Request " + str(pr_name) + ". Manual review required.",
                "Payment Result - Webhook Miss Fallback Failed"
            )

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