import test from "node:test"
import assert from "node:assert/strict"
import { parsearCertificadoTributario } from "../lib/certificado-tributario.ts"

// Transcripción REAL de la visión (HSEQTECH PREVENSA, 23-sep-2026).
const ERUT = `[El cliente envió un DOCUMENTO (PDF) por WhatsApp. Contenido del documento]: **Tipo de documento:** Rol Único Tributario (RUT) chileno emitido por el Servicio de Impuestos Internos (SII).

**Comunicación:** Documento de inscripción tributaria de la empresa HSEQTECH PREVENSA SPA.

**Datos relevantes transcritos:**

- **Empresa:** HSEQTECH PREVENSA SPA
- **RUT:** 78431963-6
- **Actividad económica:** Consultoría en Gestión, Asesoría Jurídica, Ingeniería y Servicios Ing
- **Dirección:** Cochrane 639 Of 54 Null Valparaíso
- **N° Serie:** 202608773034
- **Fecha emisión:** 09/09/2026
- **RUT Usuario/Cédula:** 15592328-8
- **Usuario Cédula:** Claudio Esteban González Brevis`

test("e-RUT del SII: razón social, RUT, giro, dirección y comuna (separadas por el Null)", () => {
  const d = parsearCertificadoTributario(ERUT)
  assert.ok(d)
  assert.equal(d!.tipo, "sii")
  assert.equal(d!.razonSocial, "HSEQTECH PREVENSA SPA")
  assert.equal(d!.documento, "78431963-6")
  assert.match(d!.giro!, /^Consultoría en Gestión/)
  assert.equal(d!.direccion, "Cochrane 639 Of 54")
  assert.equal(d!.comuna, "Valparaíso")
})

test("ficha RUC de SUNAT: dirección fiscal y distrito", () => {
  const d = parsearCertificadoTributario(`Ficha RUC - SUNAT
Número de RUC: 20605842055
Razón Social: GEOVICTORIA PERU S.A.C.
Actividad Económica Principal: Consultoría informática
Domicilio Fiscal: Av. General Trinidad Morán 1340 Urb. Risso
Distrito: Lince
Provincia: Lima`)
  assert.ok(d)
  assert.equal(d!.tipo, "sunat")
  assert.equal(d!.documento, "20605842055")
  assert.equal(d!.direccion, "Av. General Trinidad Morán 1340 Urb. Risso")
  assert.equal(d!.comuna, "Lince")
  assert.equal(d!.ciudad, "Lima")
})

test("una nómina o un comprobante NO son certificado tributario", () => {
  assert.equal(parsearCertificadoTributario("# Descripción del Documento\n**Tipo:** Nómina de Trabajadores\nLista de empleados con RUT 19.151.966-3 y correo"), null)
  assert.equal(parsearCertificadoTributario("Comprobante de transferencia Banco de Chile. Monto: $70.478. Cuenta destino 8001204108. RUT 76188587-1"), null)
})

test("certificado sin giro ni dirección no aporta y devuelve null", () => {
  assert.equal(parsearCertificadoTributario("Rol Único Tributario emitido por el SII. **Empresa:** X SPA **RUT:** 78431963-6"), null)
})
