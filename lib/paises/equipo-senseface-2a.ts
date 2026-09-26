/**
 * EQUIPO ESTÁNDAR DE PERÚ, COLOMBIA Y MÉXICO = SenseFace 2A (26-sep, Lalo
 * "revisa todas las tools… y agrega lo que falte de cada país (por ejemplo
 * falta ficha técnica de equipo?)").
 *
 * Verificado en Books el 26-sep: el equipo con stock en los tres países es el
 * SenseFace 2A ([PER] 304 · [COL] 218.1 WIFI con 202 unidades · [MEX] 123.1
 * con 43). Chile pasó al 4A el 23-sep y tiene su propia ficha. Un solo texto y
 * una sola URL para los tres: si un país cambia de equipo, se le cambia la
 * ficha en su `lib/paises/<cc>/ficha.ts`, no este archivo.
 *
 * El PDF es técnico, sin precios ni país (el mismo que usó Chile hasta el 23-sep).
 */

export const FICHA_2A_URL = "https://cotizacion.geovictoria.com/pdf/assets/ficha-reloj-senseface.pdf"

/** Datos que Vicky puede afirmar sin derivar (lo que está en la ficha, nada más). */
export const FICHA_2A_TEXTO =
  "FICHA CANÓNICA DEL EQUIPO (responde con esto, no derives): métodos de validación ROSTRO, HUELLA, TARJETA de proximidad y CONTRASEÑA (clave numérica) — el cliente elige cuáles habilitar, uno o varios (lo más común: facial con huella de respaldo) · conexión WiFi o cable de red (LAN) · capacidad 3.000 usuarios, 3.000 huellas, 3.000 tarjetas, 3.000 contraseñas y 1.500 rostros · NO incluye batería · alimentación DC 12V 3A · 20,5 × 7,4 × 3,3 cm · funciona solo, sin computador, y sube las marcas a la nube. Si pregunta el modelo, es el SenseFace 2A (así aparece en la ficha). Lo que NO está en esta ficha (grado de protección para intemperie, certificaciones eléctricas, accesorios) no lo inventes: \"eso te lo confirmo con el equipo técnico\"."
