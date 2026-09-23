import test from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { todasLasFichas, equipoOperativo } from "../lib/paises/ficha-operativa.ts"

/**
 * CANDADO DE FUENTE ÚNICA (23-sep, Lalo "¿cómo hacemos para que nunca se te
 * olvide eso?"): ningún dato de OPERACIÓN por país puede volver a escribirse
 * fuera de lib/paises/ficha-operativa.ts — cuentas bancarias, identificador de
 * la entidad, correos e ids de Zoho del equipo, zonas horarias. Este test
 * barre lib/ y app/ y FALLA si un archivo nuevo trae uno de esos literales.
 *
 * La deuda vieja (archivos que ya los tenían el 23-sep) va declarada abajo con
 * fecha: sigue existiendo, pero no puede CRECER, y cuando un archivo se limpia
 * el test exige sacarlo de la lista (así la lista solo se achica).
 */

const RAIZ = join(import.meta.dirname, "..")
const FICHA = "lib/paises/ficha-operativa.ts"

/** Archivos que YA tenían datos por país antes del candado. Solo se puede ACHICAR. */
const DEUDA_DECLARADA: Record<string, string> = {
  // "ruta": "por qué sigue ahí" — al tocar el archivo, leer de la ficha y borrar la línea.
  "app/api/vic-admin-calcom/route.ts": "23-sep, anterior al candado: tz co",
  "app/api/vic-botmaker-pe/route.ts": "23-sep, anterior al candado: tz pe",
  "app/api/vic-chats/route.ts": "23-sep, anterior al candado: tz co · tz mx",
  "app/api/vic-dapta-postcall/route.ts": "23-sep, anterior al candado: tz co",
  "app/api/vic-funnel/route.ts": "23-sep, anterior al candado: email emujica@geovictoria.com · email adiazg@geovictoria.com · email tmartinezq@geovictoria.com · email alopez@geovictoria.com · email pdiaz@geovictoria.com · email dgalvez@geovictoria.com",
  "app/api/vic-loop-cron/route.ts": "23-sep, anterior al candado: email emujica@geovictoria.com · email adiazg@geovictoria.com · email tmartinezq@geovictoria.com · email alopez@geovictoria.com · email agordillo@geovictoria.com · email ysegura@geovictoria.com",
  "app/api/vic-outbound-cadence-cron/route.ts": "23-sep, anterior al candado: email ysegura@geovictoria.com",
  "app/api/vic-outbound-lead/route.ts": "23-sep, anterior al candado: tz pe · tz co · tz mx · email ysegura@geovictoria.com",
  "app/api/vic-ptv-cron/route.ts": "23-sep, anterior al candado: tz pe · tz co · tz mx · email emujica@geovictoria.com · email adiazg@geovictoria.com · email tmartinezq@geovictoria.com",
  "lib/agent-loop.ts": "23-sep, anterior al candado: tz co",
  "lib/barrido-leads-vicky.ts": "23-sep, anterior al candado: email mmendozav@geovictoria.com · zohoId Mónica Mendoza",
  "lib/calendar.ts": "23-sep, anterior al candado: tz pe · tz co · tz mx",
  "lib/campana-reactivacion-reglas.ts": "23-sep, anterior al candado: tz pe · tz co · tz mx",
  "lib/casuistica-runtime.ts": "23-sep, anterior al candado: email aaraque@geovictoria.com · email asepulveda@geovictoria.com",
  "lib/comprobante-directiva.ts": "23-sep, anterior al candado: cuenta cl 8001204108 · identificador entidad pe · cuenta co 20200000237 · identificador entidad co",
  "lib/conciliador.ts": "23-sep, anterior al candado: email aaraque@geovictoria.com · email asepulveda@geovictoria.com",
  "lib/crm-hitos.ts": "23-sep, anterior al candado: zohoId Eddyluz Mujica · zohoId Alejandro Gordillo · zohoId Eddy Galindo · zohoId Yahel Segura",
  "lib/dash-login-correo.ts": "23-sep, anterior al candado: email pdiaz@geovictoria.com",
  "lib/directorio-ejecutivos.ts": "23-sep, anterior al candado: email emujica@geovictoria.com · email adiazg@geovictoria.com · email tmartinezq@geovictoria.com · email alopez@geovictoria.com · email pdiaz@geovictoria.com · email dgalvez@geovictoria.com",
  "lib/eventos-seguimiento.ts": "23-sep, anterior al candado: email emujica@geovictoria.com · email tmartinezq@geovictoria.com · email alopez@geovictoria.com · email pdiaz@geovictoria.com · email dgalvez@geovictoria.com · email gmelendez@geovictoria.com",
  "lib/gate-proactividad.ts": "23-sep, anterior al candado: tz pe · tz co · tz mx",
  "lib/loop-v2.ts": "23-sep, anterior al candado: tz pe · tz co · tz mx",
  "lib/onboarding-escalamiento.ts": "23-sep, anterior al candado: email aaraque@geovictoria.com",
  "lib/onboarding/configuracion.ts": "23-sep, anterior al candado: tz pe",
  "lib/paises/cl/index.ts": "23-sep, anterior al candado: email aaraque@geovictoria.com · zohoId Aleydis Araque · email asepulveda@geovictoria.com",
  "lib/paises/co/anclaje.ts": "23-sep, anterior al candado: tz co",
  "lib/paises/co/ficha.ts": "23-sep, anterior al candado: tz co",
  "lib/paises/co/index.ts": "23-sep, anterior al candado: tz co · email agordillo@geovictoria.com · email egalindo@geovictoria.com · zohoId Eddy Galindo",
  "lib/paises/co/prompt.ts": "23-sep, anterior al candado: tz co",
  "lib/paises/co/tools-unificadas.ts": "23-sep, anterior al candado: tz co",
  "lib/paises/co/tools.ts": "23-sep, anterior al candado: tz co · zohoId Alejandro Gordillo · zohoId Eddy Galindo",
  "lib/paises/mx/index.ts": "23-sep, anterior al candado: identificador entidad mx · tz mx · email ysegura@geovictoria.com",
  "lib/paises/mx/prompt.ts": "23-sep, anterior al candado: cuenta mx 1161438886 · interbancario mx · identificador entidad mx · tz mx",
  "lib/paises/mx/tools.ts": "23-sep, anterior al candado: identificador entidad mx · tz mx · zohoId Yahel Segura",
  "lib/paises/pe/ficha.ts": "23-sep, anterior al candado: tz pe",
  "lib/paises/pe/index.ts": "23-sep, anterior al candado: identificador entidad pe · tz pe · email mmendozav@geovictoria.com · email afiori@geovictoria.com · zohoId Ana Fiori · email pquispef@geovictoria.com",
  "lib/paises/pe/prompt.ts": "23-sep, anterior al candado: tz pe",
  "lib/paises/pe/tools-unificadas.ts": "23-sep, anterior al candado: tz pe",
  "lib/paises/pe/tools.ts": "23-sep, anterior al candado: tz pe · zohoId Mónica Mendoza",
  "lib/paises/tipos.ts": "23-sep, anterior al candado: tz co",
  "lib/ptv.ts": "23-sep, anterior al candado: tz pe · tz co · tz mx · email aaraque@geovictoria.com · zohoId Aleydis Araque · email mmendozav@geovictoria.com",
  "lib/sdr-calificacion.ts": "23-sep, anterior al candado: email aaraque@geovictoria.com · zohoId Aleydis Araque · email asepulveda@geovictoria.com",
  "lib/tools/agendar-reunion.ts": "23-sep, anterior al candado: email emujica@geovictoria.com · email adiazg@geovictoria.com · email aaraque@geovictoria.com · email asepulveda@geovictoria.com · email agordillo@geovictoria.com · email ysegura@geovictoria.com",
  "lib/tools/registrar-comprobante-transferencia.ts": "23-sep, anterior al candado: email cvalverde@geovictoria.com · email ysegura@geovictoria.com",
  "lib/traspaso-postpago.ts": "23-sep, anterior al candado: email aaraque@geovictoria.com · zohoId Aleydis Araque · email cvalverde@geovictoria.com · zohoId Cecilia Valverde · email ysegura@geovictoria.com",
  "lib/zoho-leads.ts": "23-sep, anterior al candado: email aaraque@geovictoria.com · zohoId Aleydis Araque · email asepulveda@geovictoria.com · email egalindo@geovictoria.com · zohoId Eddy Galindo",
}

function archivos(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === ".next" || n.startsWith(".")) continue
    const p = join(dir, n)
    const st = statSync(p)
    if (st.isDirectory()) archivos(p, out)
    else if (/\.(ts|tsx|js|mjs)$/.test(n) && !/\.d\.ts$/.test(n)) out.push(p)
  }
  return out
}

function literalesDeLaFicha(): Array<{ que: string; re: RegExp }> {
  const out: Array<{ que: string; re: RegExp }> = []
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  for (const f of todasLasFichas()) {
    for (const c of f.cuentas) {
      const d = c.numero.replace(/\D/g, "")
      if (d.length >= 8) out.push({ que: `cuenta ${f.pais} ${c.numero}`, re: new RegExp(d.replace(/^0+/, "")) })
      if (c.interbancario) out.push({ que: `interbancario ${f.pais}`, re: new RegExp(c.interbancario.replace(/\D/g, "").replace(/^0+/, "")) })
    }
    if (f.entidad.identificadorDigitos.length >= 7) out.push({ que: `identificador entidad ${f.pais}`, re: new RegExp(f.entidad.identificadorDigitos) })
    // La zona de Chile es el default histórico de decenas de reportes y no
    // rompe a un país nuevo; la de los OTROS países sí delata un mapa por país
    // escrito a mano fuera de la ficha (así se coló el vigía en hora de Santiago).
    if (f.pais !== "cl") out.push({ que: `tz ${f.pais}`, re: new RegExp(esc(f.tz)) })
  }
  for (const p of equipoOperativo()) {
    out.push({ que: `email ${p.email}`, re: new RegExp(esc(p.email), "i") })
    if (p.zohoId) out.push({ que: `zohoId ${p.nombre}`, re: new RegExp(p.zohoId) })
  }
  return out
}

function hallazgos(): Map<string, string[]> {
  const lits = literalesDeLaFicha()
  const res = new Map<string, string[]>()
  for (const dir of ["lib", "app"]) {
    for (const abs of archivos(join(RAIZ, dir))) {
      const rel = relative(RAIZ, abs).replace(/\\/g, "/")
      if (rel === FICHA) continue
      const txt = readFileSync(abs, "utf8")
      const que = lits.filter((l) => l.re.test(txt)).map((l) => l.que)
      if (que.length) res.set(rel, que)
    }
  }
  return res
}

test("ningún archivo NUEVO escribe datos de país fuera de la ficha operativa", () => {
  const h = hallazgos()
  const nuevos = Array.from(h.entries()).filter(([rel]) => !(rel in DEUDA_DECLARADA))
  const detalle = nuevos.map(([rel, que]) => `  ${rel}: ${Array.from(new Set(que)).slice(0, 6).join(" · ")}`).join("\n")
  assert.equal(
    nuevos.length,
    0,
    `Datos de país fuera de lib/paises/ficha-operativa.ts (léelos de la ficha o decláralos en DEUDA_DECLARADA con motivo):\n${detalle}`,
  )
})

test("la deuda declarada solo se achica: un archivo limpio sale de la lista", () => {
  const h = hallazgos()
  const limpios = Object.keys(DEUDA_DECLARADA).filter((rel) => !h.has(rel))
  assert.deepEqual(limpios, [], `Estos archivos ya no traen datos de país: sácalos de DEUDA_DECLARADA → ${limpios.join(", ")}`)
})

test("la ficha declara pendientes solo donde faltan datos y tiene lo mínimo en todos los países", () => {
  for (const f of todasLasFichas()) {
    assert.ok(f.cuentas.length >= 1, `${f.pais} sin cuenta bancaria`)
    assert.ok(f.bancos.length >= 1, `${f.pais} sin bancos que avisen`)
    assert.ok(f.equipo.telemarketing.length >= 1, `${f.pais} sin telemarketing`)
    assert.ok(f.tz.includes("/"), `${f.pais} sin zona horaria IANA`)
    if (!f.equipo.ventaAutonoma) assert.ok(f.pendientes.some((p) => /aut[oó]noma/i.test(p)), `${f.pais}: sin gestor de venta autónoma y no lo declara pendiente`)
    // El correo del comprobante es GLOBAL (CORREO_COMPROBANTE = vicky@, Lalo 23-sep): ningún país lo declara pendiente.
    assert.ok(!f.pendientes.some((p) => /correo de finanzas/i.test(p)), `${f.pais}: declara un correo de finanzas pendiente y el comprobante va siempre a vicky@`)
  }
})
