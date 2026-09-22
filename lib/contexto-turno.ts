/**
 * CONTEXTO POR TURNO — la parte con red del orquestador único (22-sep).
 *
 * Lo que Chile ya inyectaba desde su webhook y los demás países no:
 *   - ejecutivo asignado (traspaso activo / derivación sobre-umbral): nombre,
 *     teléfono y correo REALES — sin esto el modelo improvisaba (caso RCT 25-ago);
 *   - reenganche: primera respuesta del cliente a un toque de reactivación
 *     (activa la excepción de descuento proactivo del prompt).
 * Más las directivas deterministas del turno (lib/directivas-turno, PURO).
 *
 * Se pega AL FINAL del system prompt del país. Best-effort: cualquier fuente
 * caída devuelve "" y la conversación sigue.
 */
import { CONTEXTO_REENGANCHE, directivasDeTurno, type FichaTurno, type Turno } from "./directivas-turno"
import { isReengaged } from "./supabase-persistence-v3"
import { contextoEjecutivoAsignado } from "./ejecutivo-contexto"

export async function contextoDeTurno(
  contact: string,
  message: string,
  history: Turno[],
  ficha: FichaTurno,
): Promise<{ contexto: string; directivas: string }> {
  const [ejecutivo, reengaged] = await Promise.all([
    contextoEjecutivoAsignado(contact).catch(() => ""),
    isReengaged(contact).catch(() => false),
  ])
  return {
    // Contexto (va ANTES del prompt, como en Chile): ejecutivo + reenganche.
    contexto: (ejecutivo || "") + (reengaged ? CONTEXTO_REENGANCHE : ""),
    // Directivas (van AL FINAL del prompt, recencia).
    directivas: directivasDeTurno(message, history, ficha),
  }
}
