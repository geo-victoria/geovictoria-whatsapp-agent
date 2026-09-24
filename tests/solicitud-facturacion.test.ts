import test from "node:test"
import assert from "node:assert/strict"
import { todasLasFichas, fichaOperativa, nombreSolicitudFacturacion } from "../lib/paises/ficha-operativa.ts"
import {
  descripcionSolicitudFacturacion,
  faltantesFacturacion,
  registroSolicitudFacturacion,
  etiquetaMes,
  type DatosSolicitudFacturacion,
} from "../lib/solicitud-facturacion-payload.ts"
import { fusionarDatosFacturacion } from "../lib/datos-facturacion-puro.ts"

/**
 * Solicitud de Facturación automática (24-sep). El MOTIVO DE ANDERSON
 * ("faltan razón social, giro, dirección y comuna") tiene que quedar cerrado
 * por construcción: los datos van como campos Y en la descripción, en los 4
 * países, con la forma del golden chileno SF10268.
 */

const base = (pais: "cl" | "pe" | "co" | "mx", extra: Partial<DatosSolicitudFacturacion> = {}): DatosSolicitudFacturacion => {
  const f = fichaOperativa(pais)
  return {
    pais,
    paisNombre: f.nombre,
    layoutId: f.solicitudes.facturacionLayoutId,
    nombrePlantilla: f.solicitudes.facturacionNombre,
    area: f.solicitudes.facturacionArea,
    empresa: "Sociedad Servicios Eléctricos Tesla Austral Limitada",
    documento: "77118789-7",
    documentoEtiqueta: f.documento.etiqueta,
    giro: "Venta al por mayor de material eléctrico",
    direccion: "Rómulo Correa 0243",
    comuna: "Punta Arenas",
    telefono: "+56931910239",
    contactoNombre: "Miguel Cárcamo",
    correo: "miguel@teslak.cl",
    cuentaId: "3525045000538136402",
    referenciaNdvId: "3525045000659665741",
    urlPdfNdv: "https://gvfacturacionadm.blob.core.windows.net/quotation-pdf/NDV-31773.pdf",
    mesInicio: "2026-09-10",
    solicitanteNombre: "Aleydis Araque",
    solicitanteEmail: "aaraque@geovictoria.com",
    ...extra,
  }
}

test("los cuatro países tienen layout, nombre y área propios y distintos", () => {
  const fichas = todasLasFichas()
  const layouts = new Set(fichas.map((f) => f.solicitudes.facturacionLayoutId))
  assert.equal(layouts.size, 4)
  for (const f of fichas) {
    assert.match(f.solicitudes.facturacionLayoutId, /^\d{19}$/)
    assert.match(f.solicitudes.stLayoutId, /^\d{19}$/)
    assert.ok(f.solicitudes.facturacionNombre.includes("{empresa}"), `${f.pais}: el nombre no tiene {empresa}`)
    assert.ok(f.solicitudes.facturacionArea.length > 0)
  }
  assert.equal(nombreSolicitudFacturacion("cl", "tesla austral"), "FACTURA - GEOAVANZADO - TESLA AUSTRAL")
  assert.equal(nombreSolicitudFacturacion("pe", "Facming"), "FACTURACION - ASISTENCIA - FACMING")
})

test("el registro chileno tiene la forma del golden SF10268 y ADEMÁS los campos estructurados", () => {
  const r = registroSolicitudFacturacion(base("cl"))
  assert.equal(r.Name, "FACTURA - GEOAVANZADO - SOCIEDAD SERVICIOS ELÉCTRICOS TESLA AUSTRAL LIMITADA")
  assert.deepEqual(r.Layout, { id: "3525045000411885140" })
  assert.equal(r.Solicitud, "Facturación")
  assert.equal(r.nombre_por_colocar, "Nueva empresa")
  assert.equal(r.Pais, "Chile")
  assert.equal(r.rea_solicitante, "Telemarketing")
  assert.equal(r.Mes_Inicio_Facturaci_n, "2026-09-10")
  assert.deepEqual(r.Cuenta, { id: "3525045000538136402" })
  assert.deepEqual(r.ID_NDV, { id: "3525045000659665741" })
  assert.ok(String(r.PDF_NDV).startsWith("https://"))
  // Lo que Anderson no encontraba: como CAMPOS…
  assert.equal(r.Rut_empresa, "77118789-7")
  assert.equal(r.Giro, "Venta al por mayor de material eléctrico")
  assert.equal(r.Direcci_n, "Rómulo Correa 0243")
  assert.equal(r.Comuna, "Punta Arenas")
  assert.equal(r.Telefono_Contacto, "+56931910239")
  assert.equal(r.Contacto_facturaci_n, "Miguel Cárcamo")
  assert.equal(r.Correo_facturaci_n, "miguel@teslak.cl")
  // …y en la DESCRIPCIÓN con el bloque del equipo.
  const d = String(r.Descripci_n)
  assert.match(d, /^Favor facturar Septiembre 2026, cliente con Geoavanzado/)
  assert.match(d, /Nombre o Razón Social: Sociedad Servicios Eléctricos Tesla Austral Limitada/)
  assert.match(d, /RUT Contribuyente: 77118789-7/)
  assert.match(d, /Giro: Venta al por mayor/)
  assert.match(d, /Domicilio\/Comuna: Rómulo Correa 0243, Punta Arenas/)
  assert.match(d, /Teléfono de contacto: \+56931910239/)
  assert.match(d, /Nombre de contacto y correo: Miguel Cárcamo, miguel@teslak.cl/)
})

test("Perú y Colombia: mismo mecanismo, layout y etiqueta del documento del país", () => {
  const pe = registroSolicitudFacturacion(base("pe", { documento: "20605842055", empresa: "Facming S.A.C.", comuna: "Lince", ciudad: "Lima" }))
  assert.equal(pe.Pais, "Perú")
  assert.deepEqual(pe.Layout, { id: "3525045000429077325" })
  assert.equal(pe.Name, "FACTURACION - ASISTENCIA - FACMING S.A.C.")
  assert.match(String(pe.Descripci_n), /RUC Contribuyente: 20605842055/)
  assert.equal(pe.Ciudad, "Lima")
  const co = registroSolicitudFacturacion(base("co", { documento: "901305258-1", empresa: "Investments Faragac SAS", comuna: "Bogotá" }))
  assert.deepEqual(co.Layout, { id: "3525045000429077001" })
  assert.match(String(co.Name), /^INICIO DE FACTURACIÓN - /)
  assert.match(String(co.Descripci_n), /NIT Contribuyente: 901305258-1/)
  // Sin ciudad declarada, Ciudad = comuna (obligatoria en PE/CO/MX).
  assert.equal(co.Ciudad, "Bogotá")
})

test("con datos faltantes la solicitud nace igual, con 'por confirmar' y la lista de faltantes", () => {
  const d = base("cl", { giro: "", direccion: "", comuna: "", correo: "" })
  assert.deepEqual(faltantesFacturacion(d), ["giro", "direccion", "comuna", "correo"])
  const r = registroSolicitudFacturacion(d)
  assert.equal(r.Giro, "por confirmar")
  assert.equal(r.Comuna, "por confirmar")
  assert.equal(r.Correo_facturaci_n, undefined) // un email inválido rompería el create: se omite
  assert.match(String(r.Descripci_n), /Giro: por confirmar/)
  assert.match(String(r.Descripci_n), /Domicilio\/Comuna: por confirmar/)
  assert.equal(faltantesFacturacion(base("cl")).length, 0)
})

test("la descripción nombra la nota de hardware en USD (Perú) y el mes se escribe en español", () => {
  assert.equal(etiquetaMes("2026-01-05"), "Enero 2026")
  const d = descripcionSolicitudFacturacion(base("pe", { notaHardware: "NDV-32020 (CONFIRMADA)" }))
  assert.match(d, /Nota de venta de hardware \(USD, aparte\): NDV-32020/)
})

test("fusión de datos de facturación: lo nuevo gana, el vacío nunca pisa", () => {
  const a = fusionarDatosFacturacion(null, { giro: "Panadería", comuna: "Maipú" }, "flow")
  const b = fusionarDatosFacturacion(a, { giro: "", comuna: "Ñuñoa", direccion: "Irarrázaval 100" }, "aceptacion")
  assert.equal(b.giro, "Panadería")
  assert.equal(b.comuna, "Ñuñoa")
  assert.equal(b.direccion, "Irarrázaval 100")
  assert.equal(b.fuentes?.giro, "flow")
  assert.equal(b.fuentes?.comuna, "aceptacion")
})

test("mes de facturación: desde el día 15 parte el mes siguiente (Victoria/Nailliw 24-sep)", async () => {
  const { mesInicioFacturacion, etiquetaMes } = await import("../lib/solicitud-facturacion-payload.ts")
  assert.equal(mesInicioFacturacion("2026-09-14"), "2026-09-14")
  assert.equal(mesInicioFacturacion("2026-09-15"), "2026-10-01")
  assert.equal(mesInicioFacturacion("2026-09-24"), "2026-10-01")
  assert.equal(mesInicioFacturacion("2026-12-20"), "2027-01-01")
  assert.equal(etiquetaMes(mesInicioFacturacion("2026-09-24")), "Octubre 2026")
})
