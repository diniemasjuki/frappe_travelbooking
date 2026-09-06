# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Unit tests untuk AI Receipt OCR endpoint (travel_booking.api.receipt_ocr).

Hermetik: _get_settings dan _call_ai di-mock — tiada panggilan API sebenar,
tiada kaitan dengan state Password Travel Settings. Config flag sebenar
dipulihkan selepas setiap test.
"""

import base64
from unittest.mock import patch

import frappe
from frappe.tests import UnitTestCase

from travel_booking.api import receipt_ocr


# PNG 1x1 pixel yang sah (base64) untuk ujian saiz/jenis.
_PNG_1PX = (
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
	"+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)

_SETTINGS_ON = {
	"enabled": True,
	"base_url": "https://api.openai.com/v1",
	"model": "gpt-4o-mini",
	"api_key": "test-key",
}
_SETTINGS_OFF = {**_SETTINGS_ON, "enabled": False}


def _restore_flag():
	frappe.db.set_single_value("Travel Settings", "enable_ai_receipt_ocr", 0)
	frappe.db.commit()


class ReceiptOCRConfigTestCase(UnitTestCase):
	"""Ujian _get_settings terhadap flag sebenar (dipulihkan selepas test)."""

	def setUp(self):
		self.addCleanup(_restore_flag)

	def test_disabled_flag_means_not_enabled(self):
		frappe.db.set_single_value("Travel Settings", "enable_ai_receipt_ocr", 0)
		frappe.clear_cache(doctype="Travel Settings")
		settings = receipt_ocr._get_settings()
		self.assertFalse(settings["enabled"])


class ReceiptOCRFlowTestCase(UnitTestCase):
	"""Ujian analyze_receipt dengan settings + AI call di-mock."""

	def test_not_configured_returns_ok_false(self):
		with patch.object(receipt_ocr, "_get_settings", return_value=_SETTINGS_OFF):
			res = receipt_ocr.analyze_receipt(
				filedata="data:image/png;base64," + _PNG_1PX, filename="r.png"
			)
		self.assertFalse(res["ok"])
		self.assertEqual(res["reason"], "not_configured")

	def test_invalid_base64_rejected(self):
		with patch.object(receipt_ocr, "_get_settings", return_value=_SETTINGS_ON):
			res = receipt_ocr.analyze_receipt(filedata="bukan-base64!!!", filename="r.png")
		self.assertFalse(res["ok"])
		self.assertEqual(res["reason"], "invalid_file")

	def test_unsupported_file_type_rejected(self):
		with patch.object(receipt_ocr, "_get_settings", return_value=_SETTINGS_ON):
			res = receipt_ocr.analyze_receipt(
				filedata=base64.b64encode(b"dummy-text-file-content").decode(), filename="r.txt"
			)
		self.assertFalse(res["ok"])
		self.assertEqual(res["reason"], "invalid_file")

	def test_empty_filedata_rejected(self):
		with patch.object(receipt_ocr, "_get_settings", return_value=_SETTINGS_ON):
			res = receipt_ocr.analyze_receipt(filedata="", filename="r.png")
		self.assertFalse(res["ok"])
		self.assertEqual(res["reason"], "invalid_file")

	def test_analyze_full_flow_with_mocked_ai(self):
		def mock_call_ai(settings, payload, mime):
			self.assertEqual(mime, "image/png")
			self.assertTrue(payload)
			return {"ok": True, "reference_no": "fpX12345678", "amount": 10900.0}

		with patch.object(receipt_ocr, "_get_settings", return_value=_SETTINGS_ON):
			with patch.object(receipt_ocr, "_call_ai", side_effect=mock_call_ai):
				res = receipt_ocr.analyze_receipt(
					filedata="data:image/png;base64," + _PNG_1PX, filename="receipt.png"
				)

		self.assertTrue(res["ok"])
		self.assertEqual(res["source"], "ai")
		self.assertEqual(res["reference_no"], "FPX12345678")  # auto-uppercase
		self.assertEqual(res["amount"], 10900.0)

	def test_ai_failure_returns_ok_false_never_throws(self):
		"""Kegagalan AI TIDAK throw — client dapat ok:False untuk fallback."""

		def mock_call_ai(settings, payload, mime):
			raise RuntimeError("API down")

		with patch.object(receipt_ocr, "_get_settings", return_value=_SETTINGS_ON):
			with patch.object(receipt_ocr, "_call_ai", side_effect=mock_call_ai):
				res = receipt_ocr.analyze_receipt(
					filedata="data:image/png;base64," + _PNG_1PX, filename="receipt.png"
				)

		self.assertFalse(res["ok"])
		self.assertEqual(res["reason"], "ai_error")

	def test_ai_date_extraction_and_normalization(self):
		"""AI kini ekstrak tarikh transaksi — pulangkan dalam respons."""
		def mock_call_ai(settings, payload, mime):
			return {
				"ok": True,
				"reference_no": "FPX12345678",
				"amount": 10900.0,
				"date": "04/09/2026",
			}

		with patch.object(receipt_ocr, "_get_settings", return_value=_SETTINGS_ON):
			with patch.object(receipt_ocr, "_call_ai", side_effect=mock_call_ai):
				res = receipt_ocr.analyze_receipt(
					filedata="data:image/png;base64," + _PNG_1PX, filename="receipt.png"
				)

		self.assertTrue(res["ok"])
		self.assertEqual(res["date"], "2026-09-04")  # DD/MM/YYYY → ISO

	def test_normalize_date_variants(self):
		f = receipt_ocr._normalize_date
		self.assertEqual(f("2026-09-04"), "2026-09-04")       # ISO terus
		self.assertEqual(f("04/09/2026"), "2026-09-04")       # DD/MM/YYYY
		self.assertEqual(f("4-9-2026"), "2026-09-04")         # DD-MM-YYYY
		self.assertEqual(f("04.09.2026"), "2026-09-04")       # DD.MM.YYYY
		self.assertEqual(f("04 Sep 2026"), "2026-09-04")      # DD MMM YYYY
		self.assertEqual(f(""), "")                            # kosong
		self.assertEqual(f("YYYY-MM-DD"), "")                 # placeholder
		self.assertEqual(f("not-a-date"), "")                 # sampah

	def test_parse_ai_json_variants(self):
		# JSON bersih
		self.assertEqual(
			receipt_ocr._parse_ai_json('{"reference_no": "ABC123", "amount": 10.5}'),
			{"reference_no": "ABC123", "amount": 10.5},
		)
		# Markdown fences
		self.assertEqual(
			receipt_ocr._parse_ai_json('```json\n{"reference_no": "ABC", "amount": 1}\n```'),
			{"reference_no": "ABC", "amount": 1},
		)
		# Teks sampingan sekeliling objek JSON
		self.assertEqual(
			receipt_ocr._parse_ai_json('Here is the result: {"reference_no": "X", "amount": 2} hope it helps'),
			{"reference_no": "X", "amount": 2},
		)
		# Buang sampah
		self.assertIsNone(receipt_ocr._parse_ai_json("not json at all"))
		self.assertIsNone(receipt_ocr._parse_ai_json(""))

	def test_decode_file_data_url_and_extension(self):
		# data-URL dengan mime
		payload, mime = receipt_ocr._decode_file("data:image/jpeg;base64," + _PNG_1PX, "f.bin")
		self.assertTrue(payload)
		self.assertEqual(mime, "image/jpeg")
		# tiada mime dalam data-URL → fallback extension
		payload, mime = receipt_ocr._decode_file(_PNG_1PX, "receipt.png")
		self.assertTrue(payload)
		self.assertEqual(mime, "image/png")
		# PDF diterima
		payload, mime = receipt_ocr._decode_file(base64.b64encode(b"%PDF-1.4 dummy").decode(), "slip.pdf")
		self.assertTrue(payload)
		self.assertEqual(mime, "application/pdf")

	def test_normalize_base_url_common_paste_mistakes(self):
		f = receipt_ocr._normalize_base_url
		# Betul terus
		self.assertEqual(f("https://api.openai.com/v1"), "https://api.openai.com/v1")
		self.assertEqual(f("https://api.openai.com/v1/"), "https://api.openai.com/v1")
		# Salah tampal: kaedah HTTP + path penuh (kes sebenar 2026-09-04)
		self.assertEqual(
			f("POST https://api.openai.com/v1/chat/completions"),
			"https://api.openai.com/v1",
		)
		self.assertEqual(
			f("https://api.openai.com/v1/chat/completions"),
			"https://api.openai.com/v1",
		)
		self.assertEqual(
			f("https://api.groq.com/openai/v1/chat/completions/"),
			"https://api.groq.com/openai/v1",
		)
		# Kosong → default
		self.assertEqual(f(""), "https://api.openai.com/v1")
		self.assertEqual(f(None), "https://api.openai.com/v1")
