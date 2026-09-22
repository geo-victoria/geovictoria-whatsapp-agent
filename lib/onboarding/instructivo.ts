/**
 * INSTRUCTIVO DE INGRESO — versión WHATSAPP (Lalo 25-ago: "me gustaría la
 * versión WhatsApp del instructivo para ingresar, como lo que se envía por
 * correo"). Espejo del correo de instrucciones (lib/onboarding-correos.ts,
 * referencia plantilla GeoAvanzado): pieza ÚNICA que usan el mensaje
 * post-alta del canal y el prompt de la fase (para re-entregarlo cuando el
 * cliente pregunte cómo entrar). Módulo puro: solo texto.
 */

const MANUAL_URL_DEFAULT =
  "https://7742864.fs1.hubspotusercontent-na1.net/hubfs/7742864/Manual_Usuario_GeoVictoria_Demogva21082026.pdf"

type Opts = { manualUrl?: string; loginUrl?: string }

/** Solo los pasos + manual (para componer dentro de otros mensajes). */
export function pasosIngresoWhatsApp(opts: Opts = {}): string {
  const manual = (opts.manualUrl || MANUAL_URL_DEFAULT).trim()
  const login = (opts.loginUrl || "https://advanced.geovictoria.com").trim()
  return (
    `1. Abre el correo de no-reply@geovictoria.com con la contraseña temporal (si no aparece, revisa Promociones o Spam)\n` +
    `2. Entra a ${login} con el correo del administrador y esa contraseña\n` +
    `3. Cámbiala por una propia — y la cuenta queda operativa\n\n` +
    `📘 Manual del Administrador, para revisar a tu ritmo:\n${manual}`
  )
}

/** Mensaje completo y autónomo (cuando el cliente pregunta cómo entrar). */
export function instructivoIngresoWhatsApp(opts: Opts = {}): string {
  return `Así entras a tu cuenta 👇\n\n${pasosIngresoWhatsApp(opts)}\n\nCualquier duda me escribes por aquí 😊`
}
