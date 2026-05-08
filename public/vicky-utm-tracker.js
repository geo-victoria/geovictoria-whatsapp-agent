/**
 * Vicky UTM Tracker — GeoVictoria
 * Captura UTMs y GCLID de la URL y los codifica en el link de WhatsApp.
 *
 * Uso: incluir este script en todas las landing pages que tengan el botón de WhatsApp.
 * <script src="https://geovictoria-whatsapp-agent.vercel.app/vicky-utm-tracker.js"></script>
 *
 * El script busca automáticamente elementos con:
 *   - class="vicky-whatsapp-btn"
 *   - data-whatsapp="true"
 *   - href que contenga wa.me o api.whatsapp.com
 */

(function () {
  const PHONE = "56966765498";

  // Campos UTM a capturar
  const UTM_KEYS = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "gclid",       // Google Click ID
    "fbclid",      // Facebook Click ID (por si se usa Meta Ads también)
  ];

  function getUTMData() {
    const params = new URLSearchParams(window.location.search);
    const data = {};

    for (const key of UTM_KEYS) {
      const val = params.get(key);
      if (val) data[key] = val;
    }

    // Guardar en sessionStorage para persistir entre páginas del mismo sitio
    if (Object.keys(data).length > 0) {
      try {
        sessionStorage.setItem("vicky_utm", JSON.stringify(data));
      } catch (_) {}
    }

    // Recuperar si no hay UTMs en la URL actual pero sí en sesión previa
    if (Object.keys(data).length === 0) {
      try {
        const stored = sessionStorage.getItem("vicky_utm");
        if (stored) return JSON.parse(stored);
      } catch (_) {}
    }

    return data;
  }

  function buildWhatsAppLink(utmData) {
    // Agregar la página actual como Landing Page
    utmData["landing_page"] = window.location.href.split("?")[0];

    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(utmData))));
    const ref = "[REF:" + encoded + "]";

    return (
      "https://wa.me/" +
      PHONE +
      "?text=" +
      encodeURIComponent(ref)
    );
  }

  function applyToButtons(utmData) {
    if (Object.keys(utmData).length === 0) return;

    const link = buildWhatsAppLink(utmData);

    // Selector amplio para capturar distintos tipos de botones de WhatsApp
    const selectors = [
      ".vicky-whatsapp-btn",
      "[data-whatsapp]",
      "a[href*='wa.me']",
      "a[href*='api.whatsapp.com']",
      "a[href*='whatsapp.com/send']",
    ];

    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((el) => {
        el.href = link;
      });
    }
  }

  // Ejecutar cuando el DOM esté listo
  function init() {
    const utmData = getUTMData();
    applyToButtons(utmData);

    // Observer para elementos que se renderizan después (SPA, lazy load)
    if (window.MutationObserver) {
      new MutationObserver(() => applyToButtons(utmData)).observe(
        document.body,
        { childList: true, subtree: true }
      );
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
