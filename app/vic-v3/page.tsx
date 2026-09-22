/**
 * Página /vic-v3 — chat web para validar Vicky V3 antes de pasar a producción.
 *
 * Esta página NO está enlazada desde el resto de la app intencionalmente.
 * Solo se accede tipeando la URL directamente. Cuando V3 esté validado y
 * conectado a Botmaker, esta página puede:
 *   - mantenerse para QA continuo,
 *   - o renombrarse/eliminarse según preferencia.
 */

import VickyV3Chat from "@/components/geovictoria-sales-agent-v3"

export const metadata = {
  title: "Vicky V3 — Chat de prueba",
  description: "Entorno de validación para Vicky con tool use",
}

export default function VicV3Page() {
  return <VickyV3Chat />
}
