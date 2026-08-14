# travel_booking/www/checkout.py
import frappe
import json


def get_context(context):
    pr_name = frappe.form_dict.get("pr")
    source  = frappe.form_dict.get("src", "portal")
    ref     = frappe.form_dict.get("ref", "")

    if not pr_name or not frappe.db.exists("Payment Request", pr_name):
        frappe.throw("Payment request not found.", frappe.DoesNotExistError)

    pr = frappe.get_doc("Payment Request", pr_name)

    context.pr_name  = pr_name
    context.source   = source
    context.ref      = ref
    context.pr_name_json = json.dumps(pr_name)
    context.source_json  = json.dumps(source)
    context.ref_json     = json.dumps(ref)

    # PENTING: pr.grand_total dicap kepada baki SO TUNGGAL yang dirujuk PR
    # ini (untuk booking gabungan) — jumlah PENUH yang customer sebenarnya
    # dicaj berada dalam Stripe PaymentIntent. Cari intent guna cache
    # pr.name -> intent.id (disimpan di create_payment_intent()), BUKAN
    # stripe.PaymentIntent.search() — nombor siri Payment Request (cth
    # "ACC/PRQ/2026/00037") boleh DIGUNA SEMULA oleh Frappe selepas document
    # lama dipadam, tapi metadata Stripe pada PaymentIntent LAMA (booking/sesi
    # lain yang tak berkaitan) kekal ada nombor PR sama — search() query
    # metadata boleh pulangkan intent yang SALAH (amount dari sejarah lama,
    # tiada jaminan susunan ikut tarikh). Fallback ke pr.grand_total sahaja
    # kalau cache tiada DAN search tak jumpa apa-apa.
    amount = float(pr.grand_total or 0)
    try:
        if not (pr.status == "Paid"):
            from travel_booking.api.stripe_checkout import _get_stripe_settings
            import stripe as _stripe
            # MULTI-ACCOUNT: intent untuk PR ni dicipta oleh akaun Stripe
            # yang dikonfigurasikan untuk currency PR — retrieve dengan API
            # key akaun itu (fallback ke resolution generik untuk PR legacy
            # yang tiada currency).
            ss, _ = _get_stripe_settings(pr.currency or None)
            _stripe.api_key = ss.get_password("secret_key")

            intent = None
            cached_intent_id = frappe.cache().get_value("checkout_intent_" + pr_name)
            if cached_intent_id:
                try:
                    candidate = _stripe.PaymentIntent.retrieve(cached_intent_id)
                    if (candidate.metadata or {}).get("payment_request") == pr_name:
                        intent = candidate
                except Exception:
                    intent = None

            if intent:
                amount = float(intent.amount) / 100.0
    except Exception:
        frappe.log_error(frappe.get_traceback(), "Checkout amount lookup failed")

    context.amount    = amount
    context.currency  = pr.currency or "MYR"
    context.already_paid = (pr.status == "Paid")
    context.no_cache = 1
    context.title    = "Payment — Rarecruise"