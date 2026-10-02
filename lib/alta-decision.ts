/**
 * Qué hacer cuando la API de alta crea la EMPRESA pero no el USUARIO
 * administrador (contrato de errores de Nicolás, 02-oct). PURO: lo usa
 * onboarding-canal y lo prueban los tests de los 4 países.
 *
 * Se decide SIEMPRE por `code`, nunca por `detail`:
 *   internal_error      → reintentar una vez con la sesión, al instante
 *   user_already_exists → pedir otro correo (la sesión sigue viva 60 min)
 *   invalid_request     → pedir de nuevo los datos del administrador
 *   cualquier otro, o sin sesión → la empresa queda sin admin y se avisa al equipo
 */
import { nombreIdentificadorAdmin, type PaisOnboarding } from "./onboarding/borrador.ts"

export type AccionUsuarioFallido = "reintentar" | "pedir_otro_correo" | "pedir_datos_admin" | "empresa_sin_admin"

export function accionUsuarioFallido(code: string, haySesion: boolean, yaReintentado = false): AccionUsuarioFallido {
  if (!haySesion) return "empresa_sin_admin"
  if (code === "internal_error" && !yaReintentado) return "reintentar"
  if (code === "user_already_exists") return "pedir_otro_correo"
  if (code === "invalid_request") return "pedir_datos_admin"
  return "empresa_sin_admin"
}

/** Texto al cliente cuando el correo del admin ya tiene usuario. Neutro para los 4 países. */
export function textoPedirOtroCorreo(email: string): string {
  return (
    `Tu empresa ya quedó creada en GeoVictoria 🙌 Pero el correo ${email} ya tiene un usuario en la plataforma, así que no puedo usarlo ` +
    "como acceso del administrador. ¿Me das otro correo para el administrador? Con ese le dejo el acceso de inmediato."
  )
}

/** Texto al cliente cuando la plataforma rechazó los datos del admin; nombra el documento del país. */
export function textoPedirDatosAdmin(pais: PaisOnboarding): string {
  return (
    "Tu empresa ya quedó creada en GeoVictoria 🙌 Pero la plataforma no aceptó los datos del administrador. " +
    `¿Me confirmas su nombre, apellido, ${nombreIdentificadorAdmin(pais)} y correo? Con eso le dejo el acceso de inmediato.`
  )
}
