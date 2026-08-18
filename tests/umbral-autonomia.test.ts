/**
 * Umbral de venta autónoma (Lalo 08-ago): inbound 20 / outbound 10.
 *
 * Estas reglas son de proceso comercial, no cosméticas: si alguien cambia un
 * default o rompe el rollback clásico sin darse cuenta, Vicky vuelve a vender
 * sola hasta 50 (o deja de vender del todo). Un test se acuerda.
 */

import { test, describe, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import {
  SCOPE_MAX_SISTEMA,
  umbralInbound,
  umbralOutbound,
  formatUmbralParaPrompt,
  formatDirectivaSobreUmbral,
  paisConUmbral,
  derivacionDePais,
  cinturonPrecioSobreUmbral,
} from "../lib/umbral-autonomia.ts"

beforeEach(() => {
  delete process.env.VICKY_UMBRAL_CLASICO
  delete process.env.VICKY_UMBRAL_INBOUND
  delete process.env.VICKY_UMBRAL_OUTBOUND
})

describe("umbrales por defecto (doc 08-ago)", () => {
  test("inbound 20 / outbound 10, dentro del tope del sistema (50)", () => {
    assert.equal(umbralInbound(), 20)
    assert.equal(umbralOutbound(), 10)
    assert.equal(SCOPE_MAX_SISTEMA, 50)
  })

  test("overrides por env, con bounds sanos (1..50)", () => {
    process.env.VICKY_UMBRAL_INBOUND = "30"
    process.env.VICKY_UMBRAL_OUTBOUND = "15"
    assert.equal(umbralInbound(), 30)
    assert.equal(umbralOutbound(), 15)
    // Valores fuera de rango o basura NO se aceptan: vuelven al default.
    process.env.VICKY_UMBRAL_INBOUND = "0"
    process.env.VICKY_UMBRAL_OUTBOUND = "99"
    assert.equal(umbralInbound(), 20)
    assert.equal(umbralOutbound(), 10)
  })

  test("rollback clásico: VICKY_UMBRAL_CLASICO=1 vuelve al 50/50", () => {
    process.env.VICKY_UMBRAL_CLASICO = "1"
    assert.equal(umbralInbound(), 50)
    assert.equal(umbralOutbound(), 50)
  })
})

describe("bloque de prompt", () => {
  test("con umbral 50 (clásico) el bloque es vacío — nada cambia", () => {
    assert.equal(formatUmbralParaPrompt(50, "inbound"), "")
  })

  test("bajo 50 declara el FLUJO 21+ (Lalo 13-ago): RUT, operación, llamada o reunión", () => {
    const bloque = formatUmbralParaPrompt(20, "inbound")
    assert.match(bloque, /SOLO hasta 20 trabajadores/)
    assert.match(bloque, /INBOUND/)
    // La derivación nombra la tool y el motivo EXACTOS del toolset CL.
    assert.match(bloque, /derivar_a_soporte/)
    assert.match(bloque, /fuera_de_rango_trabajadores/)
    // Guion nuevo: RUT primero (sin ser muro), pregunta consultiva, parafraseo
    // y cierre en llamada de ejecutivo o reunión con el dueño del deal.
    assert.match(bloque, /RUT/)
    assert.match(bloque, /rutEmpresa/)
    assert.match(bloque, /operación/)
    assert.match(bloque, /no es un muro/)
    assert.match(bloque, /agendar_reunion/)
    assert.match(bloque, /consultar_disponibilidad_horario/)
    assert.match(bloque, /dueño del trato/)
    // Post-derivación: reactivo, sin proactividad (regla 10-ago intacta).
    assert.match(bloque, /REACTIVO/)
    // El flujo bajo el umbral no cambia.
    assert.match(bloque, /NO cambia en NADA/)
    // El email nunca es requisito para derivar (solo rama reunión).
    assert.match(bloque, /email SOLO si ya lo dio/)
  })

  test("outbound usa su propio umbral en el texto", () => {
    const bloque = formatUmbralParaPrompt(10, "outbound")
    assert.match(bloque, /SOLO hasta 10 trabajadores/)
    assert.match(bloque, /OUTBOUND/)
  })
})

describe("puntos de decisión del prompt CL reescritos con el umbral", () => {
  // getSystemPromptV3(contact, umbral) reescribe las líneas del FLUJO por
  // .replace() de cadenas EXACTAS (la E2E del 08-ago mostró que el modelo
  // obedece el flujo por sobre el preámbulo). El prompt usa el alias "@/lib"
  // (no importable desde el runner de node), así que se ancla por CONTENIDO:
  // si alguien edita esas líneas del prompt sin actualizar los replace, el
  // replace deja de matchear en silencio — este test lo hace reventar.
  const fuente = readFileSync(
    new URL("../app/api/vic-sales-agent-v3/prompt.ts", import.meta.url),
    "utf8",
  )

  test("las cuatro cadenas objetivo del replace siguen en el prompt", () => {
    for (const objetivo of [
      "- Si tiene 1-50 → puede cotizar (Modo Cotización).",
      '- Si tiene 50+ → no cotiza, pregunta "Prefieres reunión o callback?".',
      "Aplica cuando: el usuario pidió cotizar Y tiene entre 1 y 50 trabajadores.",
      "Cuando el camino es cotizar (1-50 trabajadores), sigue este orden:",
      "2. Cotizar — generar una cotización formal con PDF. Solo para empresas de 1 a 50 trabajadores.",
      "El ÚNICO tope de scope es la cantidad de TRABAJADORES (1 a 50).",
      "Una empresa de 43 trabajadores en 50 sucursales se cotiza igual que una en 1 oficina",
      "si las personas están dentro de 1-50, cotizas, tenga los puntos que tenga.",
      "Si el total sumado está entre 1 y 50, cotiza normal:",
      "— calcula un estimado mensual. Solo funciona para 1-50 trabajadores.",
    ]) {
      // Aparecen DOS veces: en el template del prompt y en el .replace().
      const veces = fuente.split(objetivo).length - 1
      assert.ok(
        veces >= 2,
        `la cadena ancla "${objetivo.slice(0, 40)}…" aparece ${veces} vez/veces — el replace de getSystemPromptV3 quedó desincronizado del prompt`,
      )
    }
  })

  test("los reemplazos dinámicos usan el umbral", () => {
    assert.match(fuente, /Si tiene 1-\$\{u\} → puede cotizar/)
    assert.match(fuente, /Si tiene MÁS de \$\{u\} → NO entra a cotizar/)
    assert.match(fuente, /FLUJO 21\+/)
    assert.match(fuente, /entre 1 y \$\{u\} trabajadores/)
    assert.match(fuente, /Cuando el camino es cotizar \(1-\$\{u\} trabajadores\)/)
  })
})

describe("detección determinista de dotación sobre el umbral", () => {
  test("detecta la dotación en frases reales", async () => {
    const { dotacionSobreUmbral } = await import("../lib/umbral-autonomia.ts")
    assert.equal(dotacionSobreUmbral("Somos Transportes Andina, 30 trabajadores.", 20), 30)
    assert.equal(dotacionSobreUmbral("somos 15 trabajadores en la empresa", 10), 15)
    assert.equal(dotacionSobreUmbral("tenemos 45 personas y 3 sucursales", 20), 45)
    assert.equal(dotacionSobreUmbral("120 empleados aprox", 20), 120)
  })
  test("bajo el umbral (o sin señal) no dispara", async () => {
    const { dotacionSobreUmbral } = await import("../lib/umbral-autonomia.ts")
    assert.equal(dotacionSobreUmbral("somos 15 trabajadores", 20), null)
    assert.equal(dotacionSobreUmbral("tenemos 30 sucursales", 20), null)
    assert.equal(dotacionSobreUmbral("hola, quiero cotizar", 20), null)
  })
})

describe("multi-país (réplica del 08-ago PM, orden de Lalo)", () => {
  test("paisConUmbral cubre CL/CO/MX/PE y rechaza el resto", () => {
    assert.equal(paisConUmbral("56911223344"), true)
    assert.equal(paisConUmbral("573001112233"), true)
    assert.equal(paisConUmbral("5215511112222"), true)
    assert.equal(paisConUmbral("51922067167"), true)
    assert.equal(paisConUmbral("13055551234"), false)
    assert.equal(paisConUmbral(""), false)
  })

  test("derivacionDePais nombra la tool, el motivo y el documento correctos", () => {
    const cl = derivacionDePais("56911223344")
    assert.equal(cl.tool, "derivar_a_soporte")
    assert.equal(cl.motivo, "fuera_de_rango_trabajadores")
    assert.equal(cl.docId, "RUT")
    const co = derivacionDePais("573001112233")
    assert.equal(co.tool, "derivar_a_ejecutivo")
    assert.equal(co.motivo, "mas_de_50")
    assert.equal(co.docId, "NIT")
    assert.equal(derivacionDePais("5215511112222").docId, "RFC")
    assert.equal(derivacionDePais("51922067167").docId, "RUC")
  })

  test("los formatters hablan la tool del país", () => {
    const bloqueCO = formatUmbralParaPrompt(20, "inbound", derivacionDePais("573001112233"))
    assert.match(bloqueCO, /derivar_a_ejecutivo/)
    assert.match(bloqueCO, /mas_de_50/)
    assert.ok(!/derivar_a_soporte/.test(bloqueCO))
    const dirMX = formatDirectivaSobreUmbral(30, 20, derivacionDePais("5215511112222"))
    assert.match(dirMX, /derivar_a_ejecutivo/)
    assert.match(dirMX, /RFC/)
    // CL por default sigue intacto
    assert.match(formatUmbralParaPrompt(20, "inbound"), /derivar_a_soporte/)
  })

  test("las cadenas ancla de los replace siguen en los prompts CO/MX/PE", () => {
    const comunes = [
      "1 a 50 → cotizas tú (Modo Cotización); más de 50 → NO cotizas",
      "- MODO COTIZACIÓN (1-50 personas):",
      "El ÚNICO tope es la cantidad de PERSONAS (1-50):",
      "- MODO LEAD (contacto pedido, reunión, o >50):",
    ]
    const porPais: Record<string, string[]> = {
      "co": [...comunes, "- Cotizas para empresas de 1 a 50 personas que operan en COLOMBIA."],
      "mx": [...comunes, "- Cotizas para empresas de 1 a 50 personas que operan en MÉXICO."],
      "pe": [...comunes, "- Cotizas para empresas de 1 a 50 personas que operan en PERÚ."],
    }
    for (const [pais, objetivos] of Object.entries(porPais)) {
      const fuente = readFileSync(new URL(`../lib/paises/${pais}/prompt.ts`, import.meta.url), "utf8")
      for (const objetivo of objetivos) {
        const veces = fuente.split(objetivo).length - 1
        assert.ok(
          veces >= 2,
          `${pais}: la ancla "${objetivo.slice(0, 40)}…" aparece ${veces} vez/veces — replace desincronizado`,
        )
      }
    }
  })
})

describe("cinturón de precios sobre el umbral (Lalo 18-ago, caso David Oviedo)", () => {
  test("caza montos en pesos y en UF escritos a mano por el modelo", () => {
    for (const texto of [
      "Para 30 personas el plan queda en:\n• $58.421/mes (con IVA incluido)",
      "El plan sale 1,5 UF + IVA al mes",
      "Serían UF 1,5 mensuales",
      "El arriendo del reloj es 0,35 UF",
    ]) {
      assert.equal(cinturonPrecioSobreUmbral(texto).habiaPrecio, true, `no cazó: ${texto}`)
    }
  })

  test("NO caza texto sin precios (teléfonos, horas, códigos, dotaciones)", () => {
    for (const texto of [
      "Perfecto, David! Ya tengo todo.",
      "Son 30 personas en 2 turnos, te llamo a las 18:30",
      "Tu cotización es la COT575 y el RUT 77.842.296-4",
      "te va a contactar al +56 9 4401 3873",
      "La UF es la unidad en que facturamos", // mención sin monto
    ]) {
      assert.equal(cinturonPrecioSobreUmbral(texto).habiaPrecio, false, `falso positivo: ${texto}`)
    }
  })

  test("el reemplazo no promete precio ni nombra a nadie", () => {
    const r = cinturonPrecioSobreUmbral("$1").reemplazo
    assert.ok(!/\$\s*\d|\d\s*UF/.test(r))
    assert.match(r, /ejecutivo/)
  })

  test("los cuatro webhooks pasan la respuesta por el cinturón", () => {
    for (const pais of ["v3", "co", "mx", "pe"]) {
      const src = readFileSync(new URL(`../app/api/vic-botmaker-${pais}/route.ts`, import.meta.url), "utf8")
      assert.match(src, /cinturonPrecioSobreUmbral/, `falta el cinturón en vic-botmaker-${pais}`)
    }
  })
})
