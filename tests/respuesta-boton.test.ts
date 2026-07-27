/**
 * Respuestas por BOTÓN: el cliente más explícito del embudo era el único que
 * no escuchábamos.
 *
 * CASO REAL (contacto 56992047070): el 25-jul tocó "Elegimos otro proveedor"
 * en vicky_react_47_razones. El 27-jul a las 09:25 el Loop v2 le mandó un
 * toque preguntándole cuántas personas marcarían asistencia.
 *
 * La cadena de fallos, cada eslabón invisible por separado:
 *
 *   1. Botmaker manda el payload del intent, no el texto:
 *      {"button":"Elegimos otro proveedor","entities":"{}","intent":"RuleBuilder…"}
 *   2. `esRechazo` exige length <= 60 ANTES de mirar el patrón → el payload
 *      (>100 chars) nunca llegaba al regex. Ninguna respuesta por botón se ha
 *      clasificado jamás.
 *   3. Sin rechazo, el ciclo se apagó solo, por agotamiento → 'agotado'.
 *   4. El Loop v2 cierra con opt_out/perdido/soporte/rechazo. 'agotado' no
 *      está en la lista → siguió activo y le tocó el turno.
 *
 * Los tres botones son los reales de vicky_react_47_razones / _v2, leídos de
 * la API de Botmaker el 27-jul.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  botonDeInteres,
  cierrePorBoton,
  esTextoDeBotonDeCierre,
  normalizarMensajeEntrante,
  textoDeBoton,
} from "../lib/respuesta-boton.ts"

/** El payload exacto que quedó guardado en vic_v3_messages. */
const PAYLOAD_REAL =
  '{"button":"Elegimos otro proveedor","entities":"{}","intent":"RuleBuilder-1234"}'

describe("extracción del texto del botón", () => {
  test("saca la etiqueta del payload real de Botmaker", () => {
    assert.equal(textoDeBoton(PAYLOAD_REAL), "Elegimos otro proveedor")
  })

  test("un mensaje normal no es un botón", () => {
    assert.equal(textoDeBoton("Hola, quiero cotizar"), "")
    assert.equal(textoDeBoton(""), "")
  })

  test("un JSON que no trae 'button' tampoco", () => {
    assert.equal(textoDeBoton('{"intent":"algo","entities":"{}"}'), "")
  })

  test("rescata la etiqueta aunque el JSON venga roto", () => {
    // `entities` viene como string con JSON adentro: el escapado se rompe seguido.
    const roto = '{"button":"Ya no lo necesitamos","entities":"{"a":1}","intent":"X"}'
    assert.throws(() => JSON.parse(roto))
    assert.equal(textoDeBoton(roto), "Ya no lo necesitamos")
  })
})

describe("normalización del mensaje entrante", () => {
  test("el JSON crudo NUNCA llega al modelo ni al historial", () => {
    const salida = normalizarMensajeEntrante(PAYLOAD_REAL)
    assert.equal(salida, "Elegimos otro proveedor")
    assert.ok(!salida.includes("intent"), "el payload se filtró al historial")
  })

  test("un mensaje normal pasa intacto", () => {
    assert.equal(normalizarMensajeEntrante("  10 personas  "), "10 personas")
  })

  test("y queda bajo los 60 chars que exige el detector de rechazo", () => {
    // La causa raíz #2: el payload medía >100 y el guard lo saltaba entero.
    assert.ok(PAYLOAD_REAL.length > 60, "premisa: el payload crudo era largo")
    assert.ok(normalizarMensajeEntrante(PAYLOAD_REAL).length <= 60)
  })
})

describe("clasificación de los tres botones reales", () => {
  test("los dos de pérdida cierran con 'perdido'", () => {
    for (const b of ["Elegimos otro proveedor", "Ya no lo necesitamos"]) {
      assert.equal(cierrePorBoton(`{"button":"${b}"}`), "perdido", b)
      assert.equal(esTextoDeBotonDeCierre(b), true, b)
    }
  })

  test("'Aún nos interesa' NO cierra nada", () => {
    assert.equal(cierrePorBoton('{"button":"Aún nos interesa"}'), null)
    assert.equal(esTextoDeBotonDeCierre("Aún nos interesa"), false)
    assert.equal(botonDeInteres('{"button":"Aún nos interesa"}'), true)
  })

  test("acentos y mayúsculas no cambian el veredicto", () => {
    assert.equal(esTextoDeBotonDeCierre("ELEGIMOS OTRO PROVEEDOR"), true)
    assert.equal(botonDeInteres('{"button":"Aun nos interesa"}'), true)
  })

  test("un botón desconocido no mata la conversación", () => {
    // Default conservador: si mañana alguien agrega un cuarto botón y nadie lo
    // mapea acá, el peor caso es seguir hablándole a un cliente vivo — no
    // cerrarle el ciclo a alguien que sigue interesado.
    assert.equal(cierrePorBoton('{"button":"Cuéntame más"}'), null)
  })

  test("un mensaje de texto libre no se confunde con un botón", () => {
    assert.equal(cierrePorBoton("elegimos otro proveedor para el año pasado"), null)
  })

  test("pero la etiqueta ya normalizada sigue clasificando", () => {
    // Los clasificadores corren AGUAS ABAJO de normalizarMensajeEntrante: para
    // cuando llegan, el payload ya no existe. Si cierrePorBoton solo aceptara
    // el JSON, el cierre no se dispararía nunca.
    assert.equal(cierrePorBoton("Elegimos otro proveedor"), "perdido")
  })
})

const RAIZ = new URL("..", import.meta.url).pathname
const LOOP = readFileSync(join(RAIZ, "app/api/vic-loop-cron/route.ts"), "utf8")
const WEBHOOKS = ["v3", "co", "mx"].map((p) => ({
  pais: p,
  src: readFileSync(join(RAIZ, `app/api/vic-botmaker-${p}/route.ts`), "utf8"),
}))

describe("el cableado en producción", () => {
  for (const { pais, src } of WEBHOOKS) {
    test(`${pais}: normaliza el mensaje en la ENTRADA del webhook`, () => {
      assert.match(src, /message = normalizarMensajeEntrante\(message\)/)
    })

    test(`${pais}: el botón de cierre cuenta como rechazo`, () => {
      assert.match(src, /const esRechazo =\s*\n\s*esTextoDeBotonDeCierre\(message\) \|\|/)
    })
  }

  test("v3 cierra el ciclo como 'perdido', no lo deja agotarse", () => {
    assert.match(WEBHOOKS[0].src, /const perdidaPorBoton = cierrePorBoton\(message\) === "perdido"/)
    assert.match(WEBHOOKS[0].src, /if \(perdidaPorBoton\) \{\s*(\n\s*\/\/.*)*\s*await closeFollowup\(contact, "perdido"\)/)
  })

  test("y marca la cotización pendiente como Rechazada en Zoho", () => {
    const bloque = WEBHOOKS[0].src.slice(
      WEBHOOKS[0].src.indexOf("if (perdidaPorBoton)"),
      WEBHOOKS[0].src.indexOf("} else if (usoOptOut)"),
    )
    assert.match(bloque, /marcarCotizacionRechazada/)
  })
})

/**
 * Eslabón 4: aunque el cierre quede bien puesto, el loop tiene su propia lista
 * de motivos que respeta. 'derivado' faltaba — y es el que pone el webhook
 * cuando la conversación pasó a un humano.
 */
describe("el loop respeta los cierres del motor de followups", () => {
  test("cierra en derivado: nada de vender en paralelo con un ejecutivo", () => {
    assert.match(
      LOOP,
      /\["opt_out", "perdido", "soporte", "rechazo", "derivado"\]\.includes\(reason\)/,
    )
  })
})
