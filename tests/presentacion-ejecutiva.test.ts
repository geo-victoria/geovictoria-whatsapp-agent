/**
 * Presentación de la ejecutiva (Rodrigo, 27-jul), en sus dos formas:
 *
 * 1. TOQUE DE LAS 2 HORAS: tras enviar un preform o cotización, si el cliente
 *    lleva 2 horas inactivo, el toque 1 del loop deja de ser un nudge
 *    genérico y PRESENTA a un ejecutivo con correo y WhatsApp. Desde el
 *    31-jul (tómbola de deals) en CL se presenta al DUEÑO REAL del
 *    deal/cotización si existe; el directorio fijo queda como fallback.
 *    CL: Eddyluz Mujica · CO: Alejandro Gordillo · MX: Yahel Segura.
 *    Y si el contacto ya fue traspasado a un vendedor (vic_ptv activo), el
 *    loop NO presenta a nadie: se cierra con motivo ptv_traspasado (caso
 *    Alan/vaitiare 31-jul: Ana Paula a las 11:21, Eddyluz a las 18:00).
 *
 * 2. CONFIRMACIÓN DE REUNIÓN CON NOMBRE Y WHATSAPP: la reunión de Rodrigo
 *    (prueba interna, 27-jul) se confirmó "con asepulveda" — el prefijo del
 *    email crudo. La confirmación debe decir el nombre real de la persona y
 *    su WhatsApp, en los tres países.
 *
 * Ambas son la ÚNICA excepción sancionada a "sin ejecutivo antes del pago"
 * (17-jul), y las manda el SISTEMA — los prompts lo declaran para que el
 * modelo no la contradiga ni la imite.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const RAIZ = new URL("..", import.meta.url).pathname
const leer = (p: string) => readFileSync(join(RAIZ, p), "utf8")

const LOOP = leer("app/api/vic-loop-cron/route.ts")
const AGENDAR = leer("lib/tools/agendar-reunion.ts")
const CO_TOOLS = leer("lib/paises/co/tools.ts")
const MX_TOOLS = leer("lib/paises/mx/tools.ts")

describe("el toque de las 2 horas presenta a la ejecutiva", () => {
  test("directorio por país con los tres símiles", () => {
    assert.match(LOOP, /cl: \{ nombre: "Eddyluz Mujica", email: "emujica@geovictoria\.com", whatsapp: "\+56 9 3932 1687"/)
    assert.match(LOOP, /co: \{ nombre: "Alejandro Gordillo", email: "agordillo@geovictoria\.com", whatsapp: "\+57 314 267 7765"/)
    assert.match(LOOP, /mx: \{ nombre: "Yahel Segura", email: "ysegura@geovictoria\.com", whatsapp: "\+52 55 3763 6604"/)
  })

  test("el toque 1 sale SIEMPRE a los 10 minutos, en cualquier etapa", () => {
    // Cadencia Rodrigo 10-ago: 10 min / +60 min / +22 h, independiente de la
    // etapa (reemplaza el 35' de la formal y las 2 horas del 27-jul).
    assert.match(LOOP, /touch === 1 && \(stage === "con_precio" \|\| stage === "formal"\)/)
    assert.match(LOOP, /const espera = 10 \* 60e3/)
    assert.match(LOOP, /pospuesto_10m/)
  })

  test("el loop NO presenta a nadie: los nombres los pone el traspaso de los 15", () => {
    // Si un toque presentara un ejecutivo, el traspaso presentaría OTRO
    // (tómbola) — dos nombres en minutos (bug Alan/vaitiare).
    assert.match(LOOP, /const esPresentacion = false/)
  })

  test("los toques 2 y 3 son WhatsApp con textos propios (las llamadas Dapta murieron)", () => {
    assert.match(LOOP, /TEXTOS_T2\[stage\]\[paisKey\]/)
    assert.match(LOOP, /TEXTOS_T3\[stage\]\[paisKey\]/)
    assert.doesNotMatch(LOOP, /Toque de llamada del loop/)
  })

  test("la maquinaria de presentación queda dormida pero íntegra (por si vuelve)", () => {
    assert.match(LOOP, /\? textoPresentacion\(paisKey, duenoReal\)/)
    assert.match(LOOP, /Te presento a \$\{e\.nombre\}, quien te ayudará con el resto del proceso/)
    assert.match(LOOP, /Tu cotización sigue vigente/)
  })

  test("en CL presenta al DUEÑO REAL del deal/cotización; el símil fijo es fallback", () => {
    // Caso Alan/vaitiare (31-jul): PTV presentó a Ana Paula a las 11:21 y el
    // loop presentó a Eddyluz (fija) a las 18:00 — dos nombres al mismo
    // prospecto. El toque ahora resuelve el dueño vigente antes de hablar.
    assert.match(LOOP, /duenoDealVigente\(r\.contact\)/)
    assert.match(LOOP, /duenoCotizacionVigente\(r\.contact\)/)
    assert.match(LOOP, /esPresentacion && paisKey === "cl"/)
    assert.match(LOOP, /duenoReal\?\.nombre && duenoReal\?\.email/)
    // Sin teléfono conocido, la línea de WhatsApp se omite — jamás el de otro.
    assert.match(LOOP, /e\.whatsapp \? `📱 WhatsApp: \$\{e\.whatsapp\}\\n` : ""/)
  })

  test("traspasado Y ATENDIDO: el loop se cierra sin presentar a nadie", () => {
    // El cron del PTV cierra el loop al traspasar, pero los traspasos que no
    // pasan por él (presentacion_manual) dejaban la fila viva. El loop chequea
    // el traspaso por sí mismo, ANTES de cualquier toque.
    //
    // Regla v3 (Lalo 07-ago, bug cazado el 10-ago en la auditoría de toques):
    // acá se leía `vic_ptv?estado=eq.activo` CRUDO — el candado clásico —, así
    // que bastaba el traspaso para callar a Vicky. Eso peleaba cada 10 minutos
    // con reconciliarSilencioTraspasos, que reabría el loop del cliente al que
    // el vendedor nunca contactó: 56 conversaciones traspasadas terminaron sin
    // UN solo toque. `contactosTraspasados()` aplica la regla correcta —
    // silencio solo con contacto humano REAL — y respeta el rollback
    // VICKY_PTV_CANDADO_CLASICO=1.
    assert.match(LOOP, /contactosTraspasados\(rows\.map\(\(r\) => r\.contact\)\)/)
    assert.doesNotMatch(LOOP, /vic_ptv\?estado=eq\.activo&select=contact/)
    assert.match(LOOP, /ptvActivos\.has\(r\.contact\)/)
    assert.match(LOOP, /motivo_cierre: "ptv_traspasado"/)
  })

  test("sin_precio no cambia: el nudge de siempre a la hora de siempre", () => {
    // La regla es SOLO para conversaciones con precio: presentar ejecutiva a
    // alguien que aún no vio un valor no tiene sentido comercial.
    assert.doesNotMatch(LOOP, /stage === "sin_precio"[^\n]*textoPresentacion/)
  })

  test("los tres prompts declaran la excepción para que el modelo no la contradiga", () => {
    assert.match(leer("app/api/vic-sales-agent-v3/prompt.ts"), /el sistema presenta automáticamente al ejecutivo a cargo del registro/)
    assert.match(leer("lib/paises/co/prompt.ts"), /el sistema presenta automáticamente a \$\{PERFIL_CO\.equipo\.ejecutivo\.nombre\}/)
    assert.match(leer("lib/paises/mx/prompt.ts"), /la presentación automática de \$\{PERFIL_MX\.equipo\.ejecutivo\.nombre\}/)
  })
})

describe("la confirmación de reunión da nombre y WhatsApp, nunca un prefijo de email", () => {
  test("el directorio cubre KAMs CL + los ejecutivos de los tres países", () => {
    for (const email of [
      "asepulveda@geovictoria\\.com",
      "aaraque@geovictoria\\.com",
      "emujica@geovictoria\\.com",
      "adiazg@geovictoria\\.com",
      "agordillo@geovictoria\\.com",
      "ysegura@geovictoria\\.com",
    ]) {
      assert.match(AGENDAR, new RegExp(`"${email}": \\{ nombre: "`), email)
    }
  })

  test("el fallback fuera del directorio es genérico, jamás el prefijo del correo", () => {
    assert.match(AGENDAR, /con un ejecutivo de nuestro equipo/)
    assert.doesNotMatch(AGENDAR, /organizerEmail\.split\("@"\)\[0\]/)
  })

  test("incluye correo y WhatsApp de quien atiende (Lalo 28-jul: los 3 datos)", () => {
    assert.match(AGENDAR, /📧 \$\{atiende\.email\}/)
    assert.match(AGENDAR, /📱 \$\{atiende\.whatsapp\}/)
    // Incluso sin directorio, el correo del organizador se comparte igual.
    assert.match(AGENDAR, /puedes escribir a 📧 \$\{organizerEmail\}/)
  })

  test("el resultado expone `atiende` (con email) y CO/MX lo usan en sus confirmaciones", () => {
    assert.match(AGENDAR, /atiende\?: \{ nombre: string; email\?: string; whatsapp\?: string \}/)
    assert.match(CO_TOOLS, /, con \$\{r\.atiende\.nombre\}/)
    assert.match(CO_TOOLS, /le escribes a 📧 \$\{r\.atiende\.email\}/)
    assert.match(CO_TOOLS, /📱 \$\{r\.atiende\.whatsapp\}/)
    assert.match(MX_TOOLS, /, con \$\{r\.atiende\.nombre\}/)
    assert.match(MX_TOOLS, /le escribes a 📧 \$\{r\.atiende\.email\}/)
    assert.match(MX_TOOLS, /📱 \$\{r\.atiende\.whatsapp\}/)
  })
})
