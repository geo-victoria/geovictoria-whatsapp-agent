/**
 * Los tres webhooks de país tienen que tener el MISMO presupuesto de tiempo.
 *
 * CASO QUE ORIGINA ESTE ARCHIVO (27-jul, Jackelin de Kláza SpA): escribió a
 * las 13:30 y no recibió respuesta nunca. En los logs:
 *
 *   Vercel Runtime Timeout Error: Task timed out after 60 seconds
 *
 * El turno alcanzó a escribir `last_user_at` en la conversación y murió antes
 * de persistir el mensaje y de contestar. Para el sistema la clienta "habló";
 * para la clienta, Vicky la dejó hablando sola — con la cotización formal ya
 * emitida y una pregunta abierta sobre la certificación de la Dirección del
 * Trabajo.
 *
 * El motivo era una asimetría que nadie miró: `maxDuration = 60` en la línea
 * CHILENA, que atiende el 92% del tráfico, contra 300 en CO y en MX. El 60
 * venía del 22-jun (commit 2b56e94), cuando un turno era mucho más corto. Hoy
 * un turno de cotización encadena varias iteraciones del modelo más
 * generar_link_cotizadora, que crea la cuenta en Zoho, arma el PDF y manda el
 * correo. Pasar de 60 segundos es normal, no excepcional.
 *
 * Este test no fija un número: exige que los tres sean IGUALES. Si mañana hay
 * una razón real para bajarlo, se baja en los tres o se justifica acá.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const RAIZ = new URL("..", import.meta.url).pathname
const PAISES = ["v3", "co", "mx"] as const

function maxDuration(pais: string): number {
  const src = readFileSync(join(RAIZ, `app/api/vic-botmaker-${pais}/route.ts`), "utf8")
  const m = src.match(/export const maxDuration = (\d+)/)
  assert.ok(m, `vic-botmaker-${pais} no declara maxDuration`)
  return Number(m![1])
}

describe("presupuesto de tiempo de los webhooks", () => {
  test("los tres países declaran maxDuration explícito", () => {
    for (const p of PAISES) assert.ok(maxDuration(p) > 0, p)
  })

  test("los tres tienen el MISMO presupuesto", () => {
    const [cl, co, mx] = PAISES.map(maxDuration)
    assert.deepEqual(
      { cl, co, mx },
      { cl: co, co, mx: co },
      "un país quedó con menos tiempo que sus gemelos: es el bug de Jackelin otra vez",
    )
  })

  test("y alcanza para un turno de cotización completo", () => {
    // generar_link_cotizadora sola —crear cuenta y contacto en Zoho, generar
    // el PDF, mandar el correo— se come decenas de segundos. Con 60 el turno
    // moría a mitad de camino.
    for (const p of PAISES) {
      assert.ok(
        maxDuration(p) >= 120,
        `vic-botmaker-${p} tiene ${maxDuration(p)}s: no alcanza para emitir una cotización`,
      )
    }
  })
})
