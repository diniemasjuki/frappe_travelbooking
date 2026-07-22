// booking.js — additional utilities for booking wizard
// Most logic is inline in booking.html for simplicity

// frappe.csrf_token polyfill for guest pages
if (typeof frappe === "undefined") {
  window.frappe = {
    csrf_token: document.cookie.match(/csrftoken=([^;]+)/)?.[1] || ""
  };
}