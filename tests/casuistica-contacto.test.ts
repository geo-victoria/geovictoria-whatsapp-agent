import { test } from "node:test"
import assert from "node:assert/strict"
import { clasificarCasuistica, directivaCasuistica } from "../lib/casuistica-contacto.ts"

// Casos REALES (jun-sep 2026) de leads que el equipo marcó "No Calificado".
const tipo = (msgs: string[]) => clasificarCasuistica(msgs).tipo

test("trabajador con problema de marcación (Mauricio / Grupo Norte)", () => {
  assert.equal(tipo(["Hola buenas tardes soy mauricio", "El segundo día de victoria en marcaion yo ise mi marca ion de colación por una hora y mi jefe me dise que no se marco", "Soy trabajador"]), "trabajador_cliente")
})

test("trabajadora que no recuerda el correo de acceso (Sayen)", () => {
  assert.equal(tipo(["Hola buena tarde, necesito ayuda con geovictoria", "no me acuerdo que gmail puse en Geovictoria", "Usuario", "Solamente trabajo y tengo que marcar mi asistencia hay"]), "trabajador_cliente")
})

test("colaboradora sin correo de recuperación (Ingrid)", () => {
  assert.equal(tipo(["Buen dia, quisiera su ayuda con la habilitacion en geovictoria", "Si, ya soy usuaria de geovictoria", "Colaboradora", "no recibo el correo de recuperacion"]), "trabajador_cliente")
})

test("admin de empresa cliente sin acceso (Oscar / Roadent)", () => {
  assert.equal(tipo(["hola buenos dias", "necesito de su ayuda", "no tenemos porfa de ingresar a la aplataforma", "adminitrador", "he cambiado la clave de acceso varias vecees pero no me deja netrera"]), "cliente_soporte")
})

test("RRHH nueva que ya tiene geovictoria (Stefania / HVAR)", () => {
  assert.equal(tipo(["Hola soy de recursos humanos, tenemos geovictoria pero soy nueva aun estamos impementando esto", "quisiera informacion sobre como agregar los horarios"]), "cliente_soporte")
})

test("baja del servicio (Luis / Engsolver) es administrativo, no venta", () => {
  const c = clasificarCasuistica(["Hola buenas tardes", "queremos dar de baja el servicio", "quiero dar de baja el servicio no estoy cotizando"])
  assert.equal(c.tipo, "cliente_administrativo")
  assert.equal(c.vende, false)
  assert.equal(c.motivoZoho, "Es un usuario")
})

test("factura que nos están cobrando (Amrydee / Otic Proforma)", () => {
  assert.equal(tipo(["Soy Amrydee de Otic Proforma y tenemos una factura que nos estan cobrando", "quisiera hablar con un ejecutivo para entender el concepto del cobro", "terminamos contrato el 30 de abril"]), "cliente_administrativo")
})

test("cliente que pide capacitación (Grover / Europastry)", () => {
  assert.equal(tipo(["nosotros ya trabajamos con ustedes en nuestra empresa", "Lo que necesitamos es una capacitación de la plataforma para nuestros vendedores"]), "cliente_capacitacion")
})

test("cliente actual que quiere cotizar reloj = VENTA (Annabella)", () => {
  const c = clasificarCasuistica(["Hola, soy annabella, me gustaría cotizar sus soluciones.", "ya trabajamos con ustedes, somos al rededor de 20, pero usamos marcaje por telefono, quiero cotizar por reloj facial"])
  assert.equal(c.tipo, "cliente_ampliacion")
  assert.equal(c.vende, true)
  assert.equal(c.esProspecto, true)
})

test("busca empleo", () => {
  assert.equal(clasificarCasuistica(["Hola trabaje en el Área de Aseo Part-Time y no me renovaron el Contrato... necesito urgente trabajar por favor"]).motivoZoho, "Busca empleo")
})

test("ex empleado con finiquito", () => {
  assert.equal(tipo(["Hola, soy Rafael", "yo estube trabajando para Geovictoria", "Y no me entregaron mi finiquito"]), "ex_empleado")
})

test("vendedora que hace publicidad es spam", () => {
  assert.equal(tipo(["Estimada/o, Le saluda Mireya vendedora de nueva Emar, y quisiera recordarle que estamos a su disposición para mantener su vehículo"]), "spam")
})

test("consulta laboral ajena (cuánto se paga un domingo)", () => {
  assert.equal(tipo(["Muy buenos días cuánto sale un domingo a un trabajador en colombia como recargo y todo", "Nosotros trabajamos en un restaurante y trabajamos los domingos"]), "consulta_ajena")
})

test("tarjetas para otro sistema instalado = otro hardware", () => {
  assert.equal(tipo(["Quisiera saber si tienen algun sistema de tarjeta o llavero para ingresar al biometrico de propietarios", "Es que ya tenemos el sistema instalado", "No el sistema de ustedes tenemos otro"]), "otro_hardware")
})

test("prospecto normal que pregunta por factura NO se bloquea", () => {
  const c = clasificarCasuistica(["Hola, soy Andrés, me gustaría cotizar sus soluciones.", "somos 10 en total", "app movil me interesa", "emiten facturas por servicios"])
  assert.equal(c.tipo, "prospecto")
})

test("prospecto con reloj de otra marca NO es cliente", () => {
  assert.equal(tipo(["Hola! 20 personas", "La marcacion es mediante un reloj biometrico que ya tengo", "Tengo el reloj que le compre a Buk", "Cotizame ambas"]), "prospecto")
})

test("prospecto con preguntas pre-venta de contraseña/app sigue siendo prospecto", () => {
  assert.equal(tipo(["Hola, quiero cotizar para 8 personas", "la app pide contraseña a cada trabajador?", "cuanto cuesta"]), "prospecto")
})

test("saludo solo = sin información = prospecto", () => {
  assert.equal(tipo(["Hola"]), "prospecto")
})

test("directiva existe para todo tipo no prospecto", () => {
  for (const t of ["trabajador_cliente", "cliente_soporte", "cliente_administrativo", "cliente_capacitacion", "busca_empleo", "ex_empleado", "consulta_ajena", "otro_hardware", "spam", "cliente_ampliacion"] as const) {
    assert.ok(directivaCasuistica({ tipo: t, esProspecto: false, vende: false, motivoZoho: null, evidencia: [] }).length > 50, t)
  }
  assert.equal(directivaCasuistica({ tipo: "prospecto", esProspecto: true, vende: true, motivoZoho: null, evidencia: [] }), "")
})

// 11-sep — vocabulario ensanchado con las formas REALES en que un cliente pide
// ayuda (auditoría del modo ?soporte=1: el modelo acertaba y el clasificador
// no). Se exige además que un prospecto con intención de compra NO se bloquee.
test("casuística: formas reales de pedir soporte que antes salían prospecto", () => {
  const casos: Array<[string[], string]> = [
    [["Hola", "tengo un pequeño problema", "al entrar a geovictoria", "no se como entrar"], "cliente_soporte"],
    [["tengo problemas para acceder a la plataforma", "Administrador", "credenciales incorrectas"], "cliente_soporte"],
    [["Hay un webinar", "Pero el mail no trae el link para conectarse"], "cliente_soporte"],
    [["yo ingresaba con mi rut y ahora se debe ingresar con el correo, este al parecer no esta registrado"], "cliente_soporte"],
    [["no me llega el correo de recuperacion de clave"], "cliente_soporte"],
  ]
  for (const [msgs, esperado] of casos) {
    const c = clasificarCasuistica(msgs)
    assert.equal(c.tipo, esperado, `${msgs.join(" | ")} → ${c.tipo}`)
    assert.equal(c.esProspecto, false)
  }
})

test("casuística: el prospecto que pregunta precio NO se bloquea por el vocabulario nuevo", () => {
  const c = clasificarCasuistica(["Hola, quiero cotizar control de asistencia para 12 personas", "como entro a la plataforma despues?"])
  assert.equal(c.esProspecto, true)
  const d = clasificarCasuistica(["cuanto cuesta?", "y las credenciales las manda el sistema?"])
  assert.equal(d.esProspecto, true)
})
