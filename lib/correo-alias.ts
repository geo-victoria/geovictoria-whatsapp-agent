/**
 * Alias de ENTREGA por dirección (caso Paola Díaz, 04-ago): pdiaz@ quedó
 * bloqueada PERMANENTEMENTE en la tabla de rebotes de Zoho por un envío
 * histórico (may-2026) a "pdíaz@" con tilde — Microsoft lo rechazó como
 * dirección UTF-8 inválida y Zoho, que matchea sin diacríticos, arrastra
 * también a la dirección buena. El bloqueo permanente NO se puede levantar
 * por API (solo soporte Zoho). Workaround verificado: plus-addressing de
 * Microsoft 365 — pdiaz+vicky@ entrega al MISMO buzón y para Zoho es otra
 * dirección.
 *
 * Mapa en vic_kv `mail_aliases` = JSON {"de@x.com": "a@x.com"} — extensible
 * sin deploy si otra dirección cae en la misma trampa. Best-effort: sin kv,
 * la dirección original sigue tal cual.
 */
export async function correoEntregable(email: string): Promise<string> {
  const e = (email || "").trim()
  if (!e) return email
  try {
    const { getKvValue } = await import("./supabase-persistence-v3")
    const raw = ((await getKvValue("mail_aliases")) || "").trim()
    if (!raw) return e
    const mapa = JSON.parse(raw) as Record<string, string>
    for (const [de, a] of Object.entries(mapa)) {
      if (de.trim().toLowerCase() === e.toLowerCase() && a && a.trim()) return a.trim()
    }
    return e
  } catch {
    return e
  }
}
