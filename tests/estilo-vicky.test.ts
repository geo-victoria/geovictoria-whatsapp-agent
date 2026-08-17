/**
 * Reglas de estilo y blindaje de Vicky (las de CLAUDE.md, órdenes de Eduardo).
 *
 * No son cosméticas: cada una nació de un caso real y se rompieron todas al
 * menos una vez cuando se editaba un prompt sin acordarse de la regla. Un test
 * se acuerda; una nota en un archivo no.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  sanitizarVoseo,
  normalizarFormatoWhatsApp,
  quitarSignosApertura,
  blindarContactoComercial,
} from "../lib/voseo-v3.ts"

const RAIZ = new URL("..", import.meta.url).pathname

/** Todos los .ts de prompts y textos que Vicky puede llegar a decir. */
function archivosDeTexto(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === ".next" || e === ".git" || e === "tests") continue
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith(".ts")) out.push(p)
    }
  }
  walk(join(RAIZ, "lib"))
  walk(join(RAIZ, "app"))
  return out
}

describe("prohibido 'Oye' (CLAUDE.md, 23-jul)", () => {
  test("ningún prompt ni texto hardcodeado empieza un mensaje con 'Oye'", () => {
    // Se busca el vocativo real ("Oye," / "Oye Juan"), no la palabra dentro de
    // la propia regla que lo prohíbe ni de un comentario que la explica.
    const VOCATIVO = /(?:^|["'`\n>*\-–—]\s*)Oye\b/m
    const infractores: string[] = []
    for (const f of archivosDeTexto()) {
      const contenido = readFileSync(f, "utf8")
      for (const linea of contenido.split("\n")) {
        if (!VOCATIVO.test(linea)) continue
        // Las líneas que ENUNCIAN la prohibición son legítimas.
        if (/NUNCA|PROHIBIDO|jam[aá]s|no (uses|digas|empieces)/i.test(linea)) continue
        infractores.push(`${f.replace(RAIZ, "")}: ${linea.trim().slice(0, 100)}`)
      }
    }
    assert.deepEqual(infractores, [], `"Oye" encontrado en:\n${infractores.join("\n")}`)
  })
})

describe("nada de jerga chilena en texto de cliente", () => {
  test("no aparecen chilenismos en prompts ni mensajes", () => {
    // El prompt YA prohibía la jerga ("al tiro" → "de inmediato"), pero "al
    // toque" se coló igual y llegó a la plantilla obligatoria de entrega de
    // cotización — el mensaje más frecuente del sistema (Eduardo, 26-jul).
    // Una regla escrita en prosa no se hace cumplir sola.
    const JERGA = /(?<!\p{L})(?:al ?tiro|al toque(?!\s*\d)|cach[aá]i|fome|la raja|bacán|po)(?!\p{L})/giu
    const infractores: string[] = []
    for (const f of archivosDeTexto()) {
      // Exclusiones a propósito:
      //  - loop-v2 / persistence: "toque" es vocabulario del dominio (toque 1,
      //    toque 2…), no jerga.
      //  - voseo-v3: es el sanitizador; contener estas palabras ES su trabajo.
      if (/loop-v2|supabase-persistence|voseo-v3/.test(f)) continue
      for (const linea of readFileSync(f, "utf8").split("\n")) {
        // Las líneas que ENUNCIAN la prohibición son legítimas: lo que se busca
        // es jerga en lo que Vicky DICE, no en lo que define que no debe decir.
        if (
          /PROHIBIDO|jam[aá]s|NUNCA|no uses|→ di|reemplaza|sin voseo|sin jerga|prohíbe|se escapa|normaliza|chilenismo|localismo|y similares/i.test(
            linea,
          )
        )
          continue
        // Comentarios de código: no son texto que Vicky diga.
        if (/^\s*(?:\/\/|\*|\/\*)/.test(linea)) continue
        for (const m of linea.matchAll(JERGA)) {
          infractores.push(`${f.replace(RAIZ, "")}: "${m[0]}" en ${linea.trim().slice(0, 80)}`)
        }
      }
    }
    assert.deepEqual(infractores, [], `jerga encontrada:\n${infractores.join("\n")}`)
  })
})

describe("anti-voseo chileno", () => {
  test("convierte el voseo verbal a tuteo neutro", () => {
    for (const [entrada, esperado] of [
      ["Me los pasai?", "Me los pasas?"], // caso real
      ["Querís que te lo mande?", "Quieres que te lo mande?"],
      ["Podís pagarlo en línea", "Puedes pagarlo en línea"],
      ["Cuántos trabajadores tenís?", "Cuántos trabajadores tienes?"],
      ["Estái listo?", "Estás listo?"],
    ] as const) {
      assert.equal(sanitizarVoseo(entrada), esperado)
    }
  })

  test("NO rompe palabras legítimas que se parecen al voseo", () => {
    // La lista de verbos es curada justamente por esto: una regex genérica de
    // "-ai"/"-is" se comería estas.
    for (const palabra of [
      "el país tiene 16 regiones",
      "son seis puntos de marca",
      "hicimos el análisis de asistencia",
      "juega tenis los martes",
      "hay una crisis de rotación",
      "viajó a Dubái",
    ]) {
      assert.equal(sanitizarVoseo(palabra), palabra, `se rompió: ${palabra}`)
    }
  })
})

describe("formato de WhatsApp", () => {
  test("Vicky no usa negritas (se ve a bot)", () => {
    assert.equal(normalizarFormatoWhatsApp("El plan **mensual** es"), "El plan mensual es")
    assert.equal(normalizarFormatoWhatsApp("El plan *mensual* es"), "El plan mensual es")
  })

  test("un asterisco suelto de viñeta se conserva", () => {
    assert.equal(normalizarFormatoWhatsApp("* Control de asistencia"), "* Control de asistencia")
  })

  test("se quitan los signos de apertura", () => {
    assert.equal(quitarSignosApertura("¡Hola! ¿Cómo estás?"), "Hola! Cómo estás?")
  })
})

describe("sin ejecutivo antes del pago (17-jul)", () => {
  test("el teléfono del ejecutivo se reemplaza por el de soporte", () => {
    for (const texto of [
      "Escríbele a Anderson al +56 9 3937 2058",
      "su número es 993372058".replace("993372058", "9 3937 2058"),
      "contacto: 56939372058",
    ]) {
      const out = blindarContactoComercial(texto, false)
      assert.ok(!/3937[\s).-]*2058/.test(out), `se filtró el número en: ${texto}`)
      assert.ok(out.includes("+56 9 4401 3873"), `no quedó el de soporte en: ${texto}`)
    }
  })

  test("con el pago hecho, el contacto comercial SÍ puede salir", () => {
    const texto = "Anderson te escribe al +56 9 3937 2058"
    assert.equal(blindarContactoComercial(texto, true), texto)
  })
})

describe("arriendo del reloj por zona (caso Aysén 13-ago)", () => {
  test("ninguna línea del prompt CL menciona una tarifa de arriendo sola", () => {
    // Vicky citó "0,35 UF/mes" sin conocer la comuna y al saber que era Aysén
    // el precio "subió" a 0,40 — el cliente lo cazó al segundo. Regla: toda
    // mención de una tarifa de arriendo en el prompt va SIEMPRE con su par de
    // zona (0,35 RM / 0,40 regiones); una cifra suelta invita al modelo a
    // repetirla sin comuna.
    const f = join(RAIZ, "app/api/vic-sales-agent-v3/prompt.ts")
    const infractores: string[] = []
    for (const linea of readFileSync(f, "utf8").split("\n")) {
      const tiene035 = /0,35\s*UF/.test(linea)
      const tiene040 = /0,40?\s*UF/.test(linea)
      if (tiene035 !== tiene040) infractores.push(linea.trim().slice(0, 120))
    }
    assert.deepEqual(
      infractores,
      [],
      `tarifa de arriendo sin su par de zona en prompt.ts:\n${infractores.join("\n")}`,
    )
  })
})

describe("punto fijo con supervisor lo cubre la app (Eduardo 17-ago)", () => {
  test("el prompt CL retiró la cuadrilla del menú y la app cubre el celular del supervisor", () => {
    // SUPERSEDE la regla del 14-ago, que obligaba a ofrecer la cuadrilla donde
    // hubiera un responsable a cargo. Eduardo la sacó del menú el 17-ago: el
    // mismo caso —planta, obra, local con jefe de turno— se resuelve con la app
    // marcando desde el celular del supervisor, sin una segunda modalidad que
    // explicar. Lo que se conserva es la cobertura del caso, no el nombre.
    const p = readFileSync(join(RAIZ, "app/api/vic-sales-agent-v3/prompt.ts"), "utf8")
    const bloque = p.slice(p.indexOf("REGLAS DE FIT POR MODALIDAD"), p.indexOf("REGLAS DE FIT POR MODALIDAD") + 2600)
    assert.match(bloque, /SUPERVISOR o RESPONSABLE/i)
    assert.match(bloque, /planta/i)
    assert.match(bloque, /celular del supervisor/i)
    // Y el reloj en punto fijo nunca va solo.
    assert.match(bloque, /NUNCA lo listes solo/i)
  })

  test("la cuadrilla ya no se ofrece como modalidad en el menú de marcaje", () => {
    const p = readFileSync(join(RAIZ, "app/api/vic-sales-agent-v3/prompt.ts"), "utf8")
    assert.ok(!/\d\.\s*\*\*App de marcaje por cuadrilla\*\*/.test(p), "quedó la cuadrilla en la lista de formas de marcar")
    assert.ok(!/^\d\. App de marcaje por cuadrilla/m.test(p), "quedó la cuadrilla en el menú de ejemplo")
    assert.ok(!/CUÁNDO SACAR LA CUADRILLA/.test(p), "quedó el bloque proactivo de cuadrilla")
  })
})

describe("el preform no muestra el valor de la UF del día (Eduardo 17-ago)", () => {
  test("la línea de equivalencia en pesos va sin el paréntesis de la UF", () => {
    // Al prospecto le importa el peso final; el tipo de cambio abre una
    // conversación que no aporta a la venta.
    const t = readFileSync(join(RAIZ, "lib/tools/cotizar-referencial.ts"), "utf8")
    assert.match(t, /Equivalente: \$\$\{fmtNumCL\(totalRecurrenteCLP, 0\)\} CLP\/mes`/)
    assert.ok(!/UF del día: \$\$\{fmtNumCL\(ufActual/.test(t), "quedó el valor de la UF en el mensaje al prospecto")
  })
})

describe("doble valor compacto (Eduardo 17-ago — supersede los títulos del 14-ago)", () => {
  test("las opciones usan el formato del pantallazo: recomendación + mensual + app", () => {
    // El formato viejo embebía el preform entero como Opción 1 y el mensaje se
    // hacía eterno. El nuevo es compacto: "1 - Para N personas te recomiendo
    // Reloj en arriendo + App" con el mensual IVA incluido, y la alternativa
    // solo-app como opción 2. El reloj sigue nombrando a la App en el titular
    // (la regla del 14-ago se conserva: la app nunca queda fuera).
    const t = readFileSync(join(RAIZ, "lib/tools/cotizar-referencial.ts"), "utf8")
    assert.match(t, /te recomiendo \$\{modalidadLabel\} \+ App/)
    assert.match(t, /al mes, IVA incluido/)
    assert.match(t, /marcar desde el reloj o desde el celular/)
    assert.match(t, /2\.- Una alternativa más económica sería si marcan solo mediante nuestra app/)
    assert.match(t, /Qué opción prefieres\? Con la que elijas te genero la cotización formal de inmediato/)
    assert.ok(!/Opción 1 — Reloj control físico y App/.test(t), "quedó el título viejo del 14-ago")
  })
})
