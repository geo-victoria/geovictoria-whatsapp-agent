import test from "node:test"
import assert from "node:assert/strict"
import { parsearAvisoBanco, htmlATexto, numeroCotizacionEn, isoChile } from "../lib/aviso-banco.ts"

// Fragmentos con la MISMA estructura de tablas de los correos reales leídos
// en la casilla vicky@ (17-sep). Los estilos se omiten: el parser los ignora.

const BANCOCHILE = `<div><h3>Comprobante de Transferencia </h3><p>Te informamos que SOCIEDAD GASES DEL SUR SPA ha instruido la siguiente transferencia: </p>
<table><tr><td> </td><td><strong>Datos de Destino</strong> </td></tr>
<tr><td> </td><td>Nombre Beneficiario </td><td>Victoria S.a </td><td> </td></tr>
<tr><td> </td><td>Cuenta de abono </td><td>8001204108 </td><td> </td></tr></table>
<table><tr><td> </td><td><strong>Datos de Origen</strong> </td></tr><tr><td> </td><td>Cuenta de cargo </td><td>2701245207 </td></tr></table>
<table><tr><td> </td><td><strong>Monto Operaci&oacute;n</strong> </td><td>$70.478 </td></tr></table>
<table><tr><td> </td><td><strong>Mensaje</strong> </td><td>pago cotizacion 266 </td></tr></table>
<table><tr><td><strong>Fecha y hora: </strong><br />06/08/2026 18:23 <br /><br /><strong>ID de la operaci&oacute;n: </strong><br />INT_EMP2608061823305909863900 <br /></td></tr></table></div>`

const BCI_PERSONAS = `<table><tr><td>Hola<br /><b>Victoria SA</b></td></tr><tr><td>Has <b>recibido</b> una <b>transferencia de fondos</b> de SURCONTROL SPA hacia tu cuenta del BANCO DE CHILE-EDWARDS.</td></tr></table>
<table><tr><td><b>Origen</b></td></tr></table>
<table><tr><td>Raz&oacute;n social:</td><td>SURCONTROL SPA</td></tr><tr><td>RUT:</td><td>77742692-3</td></tr><tr><td>Cuenta:</td><td>BCI/TBANC/NOVA</td></tr></table>
<table><tr><td><b>Destino</b></td></tr></table>
<table><tr><td>Nombre:</td><td>Victoria SA</td></tr><tr><td>Monto transferido:</td><td>$ 36,459</td></tr><tr><td>N&ordm; de cuenta:</td><td>000000008001204108</td></tr><tr><td>Banco:</td><td>BANCO DE CHILE-EDWARDS</td></tr><tr><td>N&ordm; de comprobante:</td><td>47211082</td></tr><tr><td>Fecha:</td><td>17/08/2026</td></tr><tr><td>Hora:</td><td>20:12</td></tr><tr><td>Correo electr&oacute;nico de contacto:</td><td>vicky@geovictoria.com</td></tr><tr><td>Mensaje:</td><td>COT524</td></tr></table>`

const BCI_EMPRESAS = `<table><tr><td><strong>Comprobante de Transferencia de Fondos</strong></td></tr><tr><td><p><strong>ESTIMADO(A) VICTORIA SA</strong>: </p><p>De acuerdo con lo instruido por nuestro cliente AGRICOLA TODOS LOS SANTOS SPA,  le informamos que con fecha 18/08/2026  se ha realizado una transferencia de fondos hacia su cuenta del banco Banco de Chile. </p>
<table><tr><td><strong>Monto transferido:</strong></td><td><strong>$56.837</strong></td></tr><tr><td><strong>Titular de la cuenta de origen:</strong></td><td><strong>AGRICOLA TODOS LOS SANTOS SPA</strong></td></tr><tr><td>Banco de origen:</td><td>Banco de Credito e Inversiones</td></tr><tr><td>Comentario para el destinatario:</td><td>COT-656</td></tr><tr><td>Numero de la operacion:</td><td>47282222</td></tr><tr><td>Fecha abono:</td><td>18/08/2026</td></tr></table></td></tr></table>`

const SANTANDER = `<table><tr><td>Comprobante</td></tr><tr><td>Transferencia de fondos</td></tr><tr><td>Estimado(a) Victoria SA:</td></tr><tr><td>Te informamos que, con fecha 10/08/2026, nuestro cliente MARIA TERESA ALLENDE GOMEZ realiz&oacute; una transferencia a tu cuenta. Este es el detalle:</td></tr>
<tr><td><table><tr><td>Monto transferido</td><td>$ 29.163</td></tr></table></td></tr>
<tr><td><table><tr><td>Datos de destino</td></tr><tr><td>Nombre</td><td>Victoria SA</td></tr><tr><td>RUT</td><td>76.188.587-1</td></tr><tr><td>Banco</td><td>Banco de Chile / Edwards-Citi</td></tr><tr><td>N&ordm; de cuenta</td><td>0-080-01-20410-8</td></tr><tr><td>Comentario</td><td>COT408</td></tr></table></td></tr></table>`

test("Banco de Chile: monto, ordenante, mensaje con número de cotización, fecha y hora, ID", () => {
  const a = parsearAvisoBanco({ from: "serviciodetransferencias@bancochile.cl", subject: "pago cotizacion 266", html: BANCOCHILE })
  assert.ok(a)
  assert.equal(a.banco, "bancochile")
  assert.equal(a.monto, 70478)
  assert.equal(a.ordenante, "SOCIEDAD GASES DEL SUR SPA")
  assert.equal(a.numeroCotizacion, "COT266")
  assert.equal(a.fechaTexto, "06/08/2026")
  assert.equal(a.hora, "18:23")
  assert.equal(a.fechaIso, "2026-08-06T22:23:00.000Z")
  assert.equal(a.nroOperacion, "INT_EMP2608061823305909863900")
  assert.equal(a.cuentaDestino, "8001204108")
  assert.equal(a.destinoNuestro, true)
})

test("BCI personas: coma de miles, RUT del ordenante, comprobante, correo de contacto", () => {
  const a = parsearAvisoBanco({ from: "contacto@bci.cl", subject: "Aviso de transferencia de fondos", html: BCI_PERSONAS })
  assert.ok(a)
  assert.equal(a.banco, "bci")
  assert.equal(a.monto, 36459)
  assert.equal(a.ordenante, "SURCONTROL SPA")
  assert.equal(a.rutOrdenante, "77742692-3")
  assert.equal(a.numeroCotizacion, "COT524")
  assert.equal(a.nroOperacion, "47211082")
  assert.equal(a.fechaTexto, "17/08/2026")
  assert.equal(a.hora, "20:12")
  assert.equal(a.correoContacto, "vicky@geovictoria.com")
  assert.equal(a.destinoNuestro, true)
})

test("BCI empresas: titular de origen, COT con guion, fecha abono", () => {
  const a = parsearAvisoBanco({ from: "transferencias@bci.cl", subject: "Aviso de Transferencia de Fondos.", html: BCI_EMPRESAS })
  assert.ok(a)
  assert.equal(a.monto, 56837)
  assert.equal(a.ordenante, "AGRICOLA TODOS LOS SANTOS SPA")
  assert.equal(a.numeroCotizacion, "COT656")
  assert.equal(a.nroOperacion, "47282222")
  assert.equal(a.fechaTexto, "18/08/2026")
})

test("Santander: el RUT impreso es el NUESTRO y no se toma como ordenante", () => {
  const a = parsearAvisoBanco({ from: "mensajeria@santander.cl", subject: "Comprobante Transferencia de fondos", html: SANTANDER })
  assert.ok(a)
  assert.equal(a.banco, "santander")
  assert.equal(a.monto, 29163)
  assert.equal(a.ordenante, "MARIA TERESA ALLENDE GOMEZ")
  assert.equal(a.rutOrdenante, "")
  assert.equal(a.numeroCotizacion, "COT408")
  assert.equal(a.fechaTexto, "10/08/2026")
  assert.equal(a.destinoNuestro, true)
})

test("una notificación de Zoho o un correo cualquiera NO es un aviso", () => {
  assert.equal(parsearAvisoBanco({ from: "systemgenerated@zohocrm.com", subject: "Zoho CRM - You Have A New Task", text: "Task assigned to you. Due Date Sep 18, 2026" }), null)
  assert.equal(parsearAvisoBanco({ from: "cliente@empresa.cl", subject: "consulta", text: "hola, ¿hacen transferencia de datos? cuesta $ 40.000" }), null)
})

test("una transferencia SALIENTE nuestra no se registra", () => {
  assert.equal(
    parsearAvisoBanco({ from: "contacto@bci.cl", subject: "Aviso", text: "Has realizado una transferencia de fondos de $ 100.000 hacia la cuenta de PROVEEDOR SPA. Fecha: 01/09/2026" }),
    null,
  )
})

test("número de cotización: COT, COT-, 'cotizacion 266' y sin falso positivo", () => {
  assert.equal(numeroCotizacionEn("COT1192"), "COT1192")
  assert.equal(numeroCotizacionEn("COT-656"), "COT656")
  assert.equal(numeroCotizacionEn("pago cotizacion 266"), "COT266")
  assert.equal(numeroCotizacionEn("Pago inicial marcaje"), "")
})

test("isoChile respeta el horario de verano/invierno de Chile", () => {
  assert.equal(isoChile("06/08/2026", "18:23"), "2026-08-06T22:23:00.000Z") // invierno, -04
  assert.equal(isoChile("16/09/2026", "11:53"), "2026-09-16T14:53:00.000Z") // verano, -03
})

test("htmlATexto separa celdas y decodifica entidades", () => {
  const t = htmlATexto("<table><tr><td>Monto&nbsp;transferido:</td><td>$&nbsp;1.234</td></tr></table>")
  assert.match(t, /Monto transferido: \| \$ 1\.234/)
})

/* ── Adjuntos (17-sep): comprobante transcrito por visión + normalización ── */

import { normalizarAdjuntos, adjuntosLegibles } from "../lib/aviso-banco.ts"

const TRANSCRITO = `Tipo: Comprobante de transferencia
Banco: Banco Santander
Monto transferido: $70.478
Titular de la cuenta de origen: SOCIEDAD GASES DEL SUR SPA
RUT: 76.543.210-K
Nombre destinatario: Victoria S.A.
Cuenta destino: 8001204108
Fecha: 06/08/2026
Hora: 18:23
Número de operación: 998877
Mensaje: pago cotizacion 266`

test("adjunto: un comprobante transcrito se parsea con el mismo parser (modo adjunto)", () => {
  const a = parsearAvisoBanco({ from: "contadora@cliente.cl", subject: "Fwd: comprobante", text: TRANSCRITO, origen: "adjunto" })
  assert.ok(a)
  assert.equal(a.origen, "adjunto")
  assert.equal(a.banco, "santander")
  assert.equal(a.monto, 70478)
  assert.equal(a.ordenante, "SOCIEDAD GASES DEL SUR SPA")
  assert.equal(a.rutOrdenante, "76543210-K")
  assert.equal(a.numeroCotizacion, "COT266")
  assert.equal(a.fechaTexto, "06/08/2026")
  assert.equal(a.hora, "18:23")
  assert.equal(a.nroOperacion, "998877")
  assert.equal(a.destinoNuestro, true)
  assert.equal(a.remitente, "contadora@cliente.cl")
})

test("adjunto: NO_ES_COMPROBANTE y una transferencia a un tercero se rechazan", () => {
  assert.equal(parsearAvisoBanco({ from: "x@y.cl", text: "NO_ES_COMPROBANTE", origen: "adjunto" }), null)
  const tercero = TRANSCRITO.replace("Victoria S.A.", "PROVEEDOR LTDA").replace("8001204108", "1234567890")
  assert.equal(parsearAvisoBanco({ from: "x@y.cl", text: tercero, origen: "adjunto" }), null)
})

test("adjunto: un banco no listado pasa como 'otro' si el destino somos nosotros", () => {
  const a = parsearAvisoBanco({ from: "x@y.cl", text: TRANSCRITO.replace("Banco Santander", "Banco Security"), origen: "adjunto" })
  assert.ok(a)
  assert.equal(a.banco, "otro")
})

test("normalizarAdjuntos entiende Power Automate, Graph, manual y string JSON", () => {
  const pa = [{ Name: "comprobante.pdf", ContentBytes: "JVBERi0x", ContentType: "application/pdf", IsInline: false, Size: 20000 }]
  const g = [{ name: "foto.jpg", contentBytes: "/9j/4AAQ", contentType: "image/jpeg", isInline: false, size: 30000 }]
  const m = [{ nombre: "x.png", base64: "data:image/png;base64,iVBORw0KGgo=", tipo: "image/png" }]
  assert.equal(normalizarAdjuntos(pa)[0].nombre, "comprobante.pdf")
  assert.equal(normalizarAdjuntos(pa)[0].bytes, 20000)
  assert.equal(normalizarAdjuntos(g)[0].tipo, "image/jpeg")
  assert.equal(normalizarAdjuntos(m)[0].base64, "iVBORw0KGgo=")
  assert.equal(normalizarAdjuntos(JSON.stringify(pa)).length, 1)
  assert.deepEqual(normalizarAdjuntos("no es json"), [])
  assert.deepEqual(normalizarAdjuntos(null), [])
  assert.deepEqual(normalizarAdjuntos([{ Name: "vacio.pdf" }]), [])
})

test("adjuntosLegibles deja fuera logos inline chicos, tipos no legibles y tope 3", () => {
  const mk = (nombre: string, tipo: string, bytes: number, inline = false) => ({ nombre, tipo, base64: "x", inline, bytes })
  const lista = [
    mk("logo.png", "image/png", 3000, true),
    mk("firma.gif", "image/gif", 2000),
    mk("comprobante.pdf", "application/pdf", 50000),
    mk("planilla.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 50000),
    mk("foto1.jpg", "image/jpeg", 90000),
    mk("foto2.jpg", "image/jpeg", 90000),
    mk("foto3.jpg", "", 90000),
    mk("foto4.jpg", "image/jpeg", 90000),
  ]
  const ok = adjuntosLegibles(lista)
  assert.deepEqual(ok.map((a) => a.nombre), ["comprobante.pdf", "foto1.jpg", "foto2.jpg"])
})

test("adjuntosLegibles: un pantallazo PEGADO en el cuerpo (inline, grande) sí se lee; el logo inline no", () => {
  const mk = (nombre: string, tipo: string, bytes: number, inline = false) => ({ nombre, tipo, base64: "x", inline, bytes })
  const ok = adjuntosLegibles([mk("image001.png", "image/png", 4000, true), mk("image002.png", "image/png", 180000, true)])
  assert.deepEqual(ok.map((a) => a.nombre), ["image002.png"])
})

/* ── Multi-país (23-sep): la ficha operativa manda, no Chile ─────────────── */

import { normalizarDocumento } from "../lib/aviso-banco.ts"
import { fichaOperativa, parsearMontoOperativo, destinoNuestroEn, fichaPorTelefono, sesionesEspejoOperativas, rosterTelemarketingOperativo } from "../lib/paises/ficha-operativa.ts"

// Formato genérico de constancia BBVA Perú (no hay muestra real en la casilla
// todavía: se calibra con el primer aviso real, la ficha lo declara pendiente).
const BBVA_PE = `<table><tr><td>Constancia de transferencia</td></tr>
<tr><td>Banco:</td><td>BBVA</td></tr>
<tr><td>Ordenante:</td><td>EMPRESA PRUEBA SAC</td></tr>
<tr><td>RUC:</td><td>20123456789</td></tr>
<tr><td>Cuenta de destino:</td><td>0011-0123-0100091134-75</td></tr>
<tr><td>Beneficiario:</td><td>GEOVICTORIA PERU S.A.C.</td></tr>
<tr><td>Importe:</td><td>S/ 118.00</td></tr>
<tr><td>Fecha de operaci&oacute;n:</td><td>22/09/2026</td></tr>
<tr><td>Hora de operaci&oacute;n:</td><td>10:15</td></tr>
<tr><td>N&uacute;mero de operaci&oacute;n:</td><td>00123456</td></tr>
<tr><td>Concepto:</td><td>COT1468</td></tr></table>`

test("Perú: aviso BBVA a nuestra cuenta → pais pe, soles con decimales, RUC del ordenante, nuestro RUC no se toma", () => {
  const a = parsearAvisoBanco({ from: "notificaciones@bbva.pe", subject: "Constancia de transferencia", html: BBVA_PE })
  assert.ok(a)
  assert.equal(a.pais, "pe")
  assert.equal(a.moneda, "PEN")
  assert.equal(a.banco, "bbva")
  assert.equal(a.monto, 118)
  assert.equal(a.rutOrdenante, "20123456789")
  assert.equal(a.ordenante, "EMPRESA PRUEBA SAC")
  assert.equal(a.numeroCotizacion, "COT1468")
  assert.equal(a.destinoNuestro, true)
  assert.equal(a.fechaTexto, "22/09/2026")
  assert.equal(a.hora, "10:15")
  // 10:15 Lima (-05) = 15:15Z
  assert.equal(a.fechaIso, "2026-09-22T15:15:00.000Z")
  assert.equal(a.nroOperacion, "00123456")
})

test("Perú: el mismo aviso reenviado por el cliente (sin dominio del banco) se resuelve por la cuenta de destino", () => {
  const a = parsearAvisoBanco({ from: "contador@cliente.pe", subject: "Fwd: pago", html: BBVA_PE })
  assert.ok(a)
  assert.equal(a.pais, "pe")
  assert.equal(a.monto, 118)
})

test("Perú: una constancia a la cuenta de un TERCERO no se acepta aunque diga BBVA", () => {
  const tercero = BBVA_PE.replace("0011-0123-0100091134-75", "0011-0999-0100000000-11").replace("GEOVICTORIA PERU S.A.C.", "OTRA EMPRESA SAC")
  assert.equal(parsearAvisoBanco({ from: "contador@cliente.pe", subject: "Fwd: pago", html: tercero }), null)
})

test("Colombia: Bancolombia a la cuenta de ahorros → pais co, pesos sin decimales, NIT del ordenante", () => {
  const html = `<table><tr><td>Bancolombia te informa</td></tr><tr><td>Transferencia recibida</td></tr>
<tr><td>Ordenante:</td><td>SERVICIOS ANDINOS SAS</td></tr><tr><td>NIT:</td><td>900123456-7</td></tr>
<tr><td>Cuenta destino:</td><td>20200000237</td></tr><tr><td>Monto:</td><td>$ 1.150.000</td></tr>
<tr><td>Fecha:</td><td>22/09/2026</td></tr><tr><td>Referencia:</td><td>ABC12345</td></tr><tr><td>Descripci&oacute;n:</td><td>COT 1600</td></tr></table>`
  const a = parsearAvisoBanco({ from: "alertasynotificaciones@bancolombia.com", subject: "Transferencia recibida", html })
  assert.ok(a)
  assert.equal(a.pais, "co")
  assert.equal(a.moneda, "COP")
  assert.equal(a.banco, "bancolombia")
  assert.equal(a.monto, 1150000)
  assert.equal(a.rutOrdenante, "900123456-7")
  assert.equal(a.numeroCotizacion, "COT1600")
  assert.equal(a.destinoNuestro, true)
})

test("ficha operativa: montos, documentos, destino y equipo por país", () => {
  assert.equal(parsearMontoOperativo("$ 36,459", "cl"), 36459)
  assert.equal(parsearMontoOperativo("S/ 1,234.50", "pe"), 1234.5)
  assert.equal(parsearMontoOperativo("118.00", "pe"), 118)
  assert.equal(parsearMontoOperativo("1.150.000", "co"), 1150000)
  assert.equal(parsearMontoOperativo("2,500.00", "mx"), 2500)
  assert.equal(normalizarDocumento("76.543.210-K"), "76543210-K")
  assert.equal(normalizarDocumento("20123456789", "RUC"), "20123456789")
  assert.equal(normalizarDocumento("900.123.456-7", "NIT"), "900123456-7")
  assert.equal(destinoNuestroEn("abono a la cuenta 8001204108"), "cl")
  assert.equal(destinoNuestroEn("CCI 011-123-000100091134-75"), "pe")
  assert.equal(destinoNuestroEn("GEOVICTORIA COLOMBIA SAS"), "co")
  assert.equal(destinoNuestroEn("a favor de PROVEEDOR LTDA"), null)
  assert.equal(fichaPorTelefono("51987654321").pais, "pe")
  assert.equal(fichaPorTelefono("56912345678").pais, "cl")
  assert.equal(fichaPorTelefono("573001234567").pais, "co")
  const sesiones = sesionesEspejoOperativas()
  for (const s of ["emujica", "aaraque", "mmendozav", "afiori", "pquispef"]) assert.ok(sesiones.includes(s), `falta sesión ${s}`)
  // Las gestoras de la venta autónoma de PE y CO no llevan espejo (Lalo 23-sep: Cecilia; Gabriela igual).
  for (const s of ["cvalverde", "glinares"]) assert.ok(!sesiones.includes(s), `${s} no lleva espejo`)
  assert.equal(fichaOperativa("co").equipo.ventaAutonoma?.email, "glinares@geovictoria.com")
  assert.equal(fichaOperativa("co").equipo.lider, "mcelyv@geovictoria.com")
  assert.equal(fichaOperativa("co").equipo.liderSdr, "amorenom@geovictoria.com")
  assert.ok(rosterTelemarketingOperativo("pe").some((p) => p.email === "mmendozav@geovictoria.com"))
  assert.ok(!rosterTelemarketingOperativo("cl").some((p) => /aaraque|asepulveda/.test(p.email)), "las SDR no son telemarketing")
})

test("Itaú empresas y BICE (avisos reales 24-sep): 'Monto de transferencia' y 'ha instruido realizar'", () => {
  const itau = `<p>Comprobante de transferencia a terceros</p><p>Hola <strong>VICTORIA SA</strong>, adjuntamos el detalle de la transferencia realizada por <strong>DECO CHILE SPA</strong>. </p><p>Monto de transferencia</p><p>$ 123.464</p><p>Mensaje de DECO CHILE SPA:</p><p>PAGO INICIAL GEO VICTORIA </p><table><tr><td>Destinatario: </td><td>VICTORIA SA </td></tr><tr><td>RUT destinatario: </td><td>76.188.587-1 </td></tr><tr><td>Número de cuenta: </td><td>8001204108 </td></tr></table><p>Fecha de la transacción: 24/09/2026 - 15:57:45</p>`
  const a = parsearAvisoBanco({ from: "itauempresas@itau.cl", subject: "Comprobante de Transferencia a Terceros", html: itau })
  assert.ok(a)
  assert.equal(a!.monto, 123464)
  assert.equal(a!.banco, "itau")
  assert.equal(a!.ordenante, "DECO CHILE SPA")
  assert.match(a!.mensaje, /PAGO INICIAL/)
  const bice = `<div>Victoria S.A<br /><b>BUSMATICK ANDINA SPA ha instruido realizar una transferencia a su cuenta por:</b></div><div><b>Monto:</b><br /><b>$ 40684</b></div><div><b>Tu cuenta:<br />Banco de Chile-Edwards-Citi<br />Cuenta Corriente N° 8001204108</b><br />RUT: 76.188.587-1</div><div>Detalle: Servicio de septiembre<br /><b>Enviada por:<br />BUSMATICK ANDINA SPA</b><br />RUT: 76.701.534-8</div>`
  const b = parsearAvisoBanco({ from: "reply@info.bice.cl", subject: "Aviso de transferencia de fondos", html: bice })
  assert.ok(b)
  assert.equal(b!.monto, 40684)
  assert.equal(b!.ordenante, "BUSMATICK ANDINA SPA")
  assert.equal(b!.rutOrdenante, "76701534-8")
  assert.match(b!.mensaje, /Servicio de septiembre/)
})

test("Scotiabank empresas (real 24-sep): celda vacía entre 'Mensaje:' y el número de cotización", () => {
  const html = `<table><tr><td>Aviso de Transferencia </td></tr><tr><td>de fondos recibida </td></tr></table><table><tr><td>Le informamos que nuestro(a) cliente <strong>ITALSE SPA.</strong>, con fecha <strong>24/09/26 08:25:03</strong> ha efectuado una transferencia de fondos hacia su cuenta con el siguiente detalle: </td></tr><tr><td>Monto <strong>$ 246.390</strong></td></tr></table><table><tr><td> </td><td>Cuenta:</td><td></td><td><strong>8001204108</strong></td><td> </td></tr><tr><td> </td><td>Mensaje:</td><td></td><td><strong>COT1654</strong></td><td> </td></tr></table>`
  const a = parsearAvisoBanco({ from: "avisos.empresa.info@scotiabank.cl", subject: "Transferencia otros Bancos - Transacción Realizada", html })
  assert.ok(a)
  assert.equal(a!.monto, 246390)
  assert.equal(a!.numeroCotizacion, "COT1654")
  assert.equal(a!.ordenante, "ITALSE SPA.")
})

// Santander 25-sep (COT1566 SG VIAJES): la fecha va entre "Monto transferido" y
// el monto, y el número de operación viene en columnas junto al banco de origen.
const SANTANDER_COLUMNAS = `<table><tr><td><h1>Aviso de Transferencia de Fondos</h1></td></tr><tr><td>Victoria S.A, ha recibido una transferencia</td></tr>
<tr><td><p>De acuerdo con lo instruido por nuestro cliente SG VIAJES SPA, le informamos que con Fecha: 25-09-2026 se ha realizado una transferencia de fondos hacia su cuenta del banco BANCO CHILE nro. 000-000080-0120410-8.</p></td></tr>
<tr><td><table><thead><tr><td>Rut cuenta origen</td><td>Titular cuenta origen</td></tr></thead><tbody><tr><td>76.483.155-1</td><td>SG VIAJES SPA</td></tr></tbody>
<thead><tr><td>Banco de Origen</td><td>Numero de la operacion</td></tr></thead><tbody><tr><td>Santander</td><td>20260925120490568128</td></tr></tbody>
<thead><tr><td>Comentario para el destinatario</td></tr></thead><tbody><tr><td>COT1566</td></tr></tbody></table></td></tr></table>
<table><tr><td><p><strong>Monto transferido</strong></p><p>25-09-2026</p></td><td><p>$ 48.293</p></td></tr></table>`

test("Santander en columnas: la fecha antes del monto no se lee como monto; la operación exige dígitos", () => {
  const a = parsearAvisoBanco({ from: "mensajeria@santander.cl", subject: "Aviso de Transferencia de Fondos", html: SANTANDER_COLUMNAS })
  assert.ok(a)
  assert.equal(a!.monto, 48293)
  assert.equal(a!.nroOperacion, "20260925120490568128")
  assert.equal(numeroCotizacionEn(a!.mensaje || ""), "COT1566")
})
