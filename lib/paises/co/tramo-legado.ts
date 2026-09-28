/**
 * TABLA ANTERIOR DE COLOMBIA PARA QUIEN YA VIO PRECIO (Lalo 28-sep: "no le
 * cambiemos los precios a los que ya dimos precios").
 *
 * El 28-sep la regla del plan pasó a $315.000 fijo de 1 a 20 personas. Los
 * contactos que antes recibieron un precio por usuario de 11 a 20 quedaron
 * marcados en vic_kv `co_tramo_legado_<fono>`; si vuelven a cotizar, piden su
 * formal o la actualizan, se les calcula con la tabla que vieron.
 * Sin lectura (Supabase caído) → tabla vigente: nunca frena la conversación.
 */
export async function tramoLegadoCO(contact: string): Promise<boolean> {
  const fono = String(contact || "").replace(/\D/g, "")
  if (!fono) return false
  try {
    const { getKvValue } = await import("../../supabase-persistence-v3")
    const v = await getKvValue(`co_tramo_legado_${fono}`)
    return Boolean(v && v !== "off")
  } catch {
    return false
  }
}
