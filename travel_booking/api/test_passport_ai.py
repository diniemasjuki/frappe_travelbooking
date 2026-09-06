# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Unit tests untuk AI passport extraction (portal_traveller._ai_extract_passport).

Hermetik: _get_settings + OpenAI client di-mock — tiada panggilan API sebenar.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from frappe.tests import UnitTestCase

from travel_booking.api import portal_traveller
from travel_booking.api import receipt_ocr


def _mock_openai_response(content: str):
	"""Bina mock response objek yang bentuknya sama macam SDK OpenAI."""
	msg = SimpleNamespace(content=content)
	choice = SimpleNamespace(message=msg)
	return SimpleNamespace(choices=[choice])


def _settings(enabled=True):
	return {
		"enabled": enabled,
		"base_url": "https://api.openai.com/v1",
		"model": "gpt-4o-mini",
		"api_key": "test-key",
	}


_PNG_1PX = (
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
	"+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


class PassportAIExtractionTestCase(UnitTestCase):
	def _run(self, ai_content, settings=None):
		client = MagicMock()
		client.chat.completions.create.return_value = _mock_openai_response(ai_content)
		# _get_settings di-import LOKAL dalam _ai_extract_passport dari modul
		# receipt_ocr — patch pada modul sumber supaya import masa-panggil
		# mendapat mock.
		with patch.object(receipt_ocr, "_get_settings", return_value=settings or _settings()):
			# Import lokal 'from openai import OpenAI' dalam fungsi akan dapat
			# kelas yang di-patch ini.
			with patch("openai.OpenAI", return_value=client):
				import base64
				content = base64.b64decode(_PNG_1PX)
				return portal_traveller._ai_extract_passport(content)

	def test_not_configured_returns_none(self):
		self.assertIsNone(self._run("{}", settings=_settings(enabled=False)))

	def test_full_extraction_with_normalization(self):
		res = self._run(
			'{"first_name": "AHMAD", "last_name": "BIN ALI", "ic_number": "901010145522", '
			'"gender": "M", "date_of_birth": "10/10/1990", "passport_no": "A12345678", '
			'"passport_expiry": "2025-06-15", "nationality_code": "MYS", '
			'"place_of_birth": "KUALA LUMPUR", "issue_date": "", "extra_field": "ignored"}'
		)
		self.assertEqual(res["first_name"], "AHMAD")
		self.assertEqual(res["last_name"], "BIN ALI")
		self.assertEqual(res["ic_number"], "901010145522")
		self.assertEqual(res["gender"], "Male")  # M → Male
		self.assertEqual(res["date_of_birth"], "1990-10-10")  # dd/mm/yyyy → YYYY-MM-DD
		self.assertEqual(res["passport_no"], "A12345678")
		self.assertEqual(res["passport_expiry"], "2025-06-15")
		self.assertEqual(res["nationality_code"], "MYS")
		self.assertEqual(res["place_of_birth"], "KUALA LUMPUR")
		self.assertNotIn("issue_date", res)  # kosong dibuang
		self.assertNotIn("extra_field", res)  # medan luar prompt dibuang

	def test_garbage_response_returns_none(self):
		self.assertIsNone(self._run("not json at all"))

	def test_markdown_fenced_response_parsed(self):
		res = self._run('```json\n{"first_name": "TEST", "gender": "Female"}\n```')
		self.assertEqual(res["first_name"], "TEST")
		self.assertEqual(res["gender"], "Female")

	def test_placeholder_dates_dropped(self):
		res = self._run('{"first_name": "X", "date_of_birth": "YYYY-MM-DD", "ic_number": "N/A"}')
		self.assertEqual(res, {"first_name": "X"})
