/**
 * REGLA DE ASIGNACIÓN (Lalo, 27-jul): si el cliente ya tiene cotización, la
 * reunión es del DUEÑO del deal/cotización; sin cotización, asigna el
 * round-robin de Cal.com.
 *
 * ORIGEN: 4 clientes con reunión y cotización a la vez, repartidos entre 2-4
 * personas cada uno (Siman Trio llegó a tener dos reuniones con dos KAMs
 * distintas más la cotización de Anderson). Cada tool asignaba por su lado y
 * ninguna consultaba a la otra.
 *
 * Como el ORDEN reunión/cotización no se conoce de antemano, la regla se
 * aplica en las DOS direcciones:
 *   a) reunión con cotización previa → lead y evento nacen a nombre del dueño
 *      de la cotización (agendar-reunion.ts);
 *   b) cotización con reunión futura ya agendada → el lead de esa reunión se
 *      REASIGNA al dueño (generar-link-cotizadora.ts).
 * En ambas, Cal.com no permite mover el host por API: el aviso interno pide
 * traspasar la invitación, pero el CRM queda coherente solo.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const RAIZ = new URL("..", import.meta.url).pathname
const AGENDAR = readFileSync(join(RAIZ, "lib/tools/agendar-reunion.ts"), "utf8")
const COTIZAR = readFileSync(join(RAIZ, "lib/tools/generar-link-cotizadora.ts"), "utf8")

describe("dirección A: reunión cuando ya hay cotización", () => {
  test("se consulta el dueño de la cotización vigente antes de asignar", () => {
    assert.match(AGENDAR, /async function duenoCotizacionVigente/)
    assert.match(AGENDAR, /const dueno = await duenoCotizacionVigente\(telefono \|\| ""\)/)
  })

  test("el responsable es el dueño del deal; Cal solo si no hay cotización", () => {
    assert.match(AGENDAR, /const responsableEmail = dueno\?\.email \|\| organizerEmail/)
  })

  test("lead nuevo, lead pre-existente y evento usan al responsable, no al KAM", () => {
    assert.match(AGENDAR, /ownerEmail: responsableEmail/)
    assert.match(AGENDAR, /updateZohoLeadOwner\(existingLeadId, responsableEmail\)/)
    assert.match(AGENDAR, /hostEmail: responsableEmail/)
    // Ningún camino de asignación quedó apuntando al organizador de Cal.
    assert.doesNotMatch(AGENDAR, /ownerEmail: organizerEmail/)
    assert.doesNotMatch(AGENDAR, /hostEmail: organizerEmail/)
  })

  test("con conflicto real avisa al equipo para mover la invitación de Cal", () => {
    assert.match(AGENDAR, /dueno && organizerEmail && dueno\.email !== organizerEmail/)
    assert.match(AGENDAR, /Falta mover la invitación en Cal\.com/)
  })

  test("el cliente escucha el nombre de quien VA a atenderlo", () => {
    // Desde la observación de Rodrigo (27-jul), el nombre sale del DIRECTORIO
    // con el dueño de la cotización como primera fuente.
    assert.match(AGENDAR, /const atiende = dueno\s*\n\s*\? DIRECTORIO\[dueno\.email\]/)
    assert.match(AGENDAR, /atiende \? `, con \$\{atiende\.nombre\}`/)
  })

  test("best-effort: sin cotización o con Zoho caído, el flujo es el de siempre", () => {
    const fn = AGENDAR.slice(
      AGENDAR.indexOf("async function duenoCotizacionVigente"),
      AGENDAR.indexOf("// Mismo destinatario interno"),
    )
    assert.match(fn, /catch \{\s*return null\s*\}/)
    assert.match(fn, /if \(!quoteId\) return null/)
  })
})

describe("dirección B: cotización cuando ya hay reunión futura", () => {
  test("tras emitir, se busca la reunión agendada del contacto", () => {
    assert.match(COTIZAR, /async function alinearReunionExistente/)
    assert.match(COTIZAR, /vic_v3_meetings\?contact=eq\..*status=eq\.scheduled/)
    assert.match(COTIZAR, /start_at=gt\./)
  })

  test("el lead de esa reunión se reasigna al dueño de la cotización", () => {
    assert.match(COTIZAR, /updateZohoLeadOwner\(reunion\.zoho_lead_id, duenoEmail\)/)
  })

  test("si los emails coinciden no hay nada que hacer", () => {
    assert.match(COTIZAR, /duenoEmail === \(reunion\.organizer_email \|\| ""\)\.trim\(\)\) return/)
  })

  test("el aviso dice si la reasignación salió o hay que hacerla a mano", () => {
    assert.match(COTIZAR, /reasignado a \$\{duenoNombre\}/)
    assert.match(COTIZAR, /NO se pudo reasignar \(revisar a mano\)/)
  })

  test("es best-effort: jamás afecta la emisión de la cotización", () => {
    // El await vive DESPUÉS del guard de error y la función atrapa todo.
    const idx = COTIZAR.indexOf("await alinearReunionExistente(")
    const guard = COTIZAR.indexOf("if (!data || !data.acceptanceUrl)")
    assert.ok(guard > 0 && idx > guard, "la alineación corre antes del guard de éxito")
    assert.match(COTIZAR, /catch \(e\) \{\s*\n\s*console\.warn\("\[generar_link_cotizadora\] alinearReunionExistente falló/)
  })
})
