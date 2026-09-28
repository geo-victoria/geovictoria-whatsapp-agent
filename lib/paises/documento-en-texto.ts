/**
 * DOCUMENTO TRIBUTARIO DE LA EMPRESA escrito en un texto, por país (28-sep,
 * paso 4 de la unificación): RUT (CL) · RUC (PE) · NIT (CO) · RFC (MX). Antes
 * cada consumidor elegía el extractor con `startsWith("51") ? rucEnTexto : …`
 * en tres lugares distintos (ptv-cron, crm-hitos, extraer-datos-chat); ahora
 * la FICHA OPERATIVA dice qué documento usa el país y este módulo el
 * extractor que le corresponde. Un país nuevo declara su `documento.etiqueta`
 * y, si trae un documento nuevo, suma UNA entrada acá.
 *
 * PURO: sin red ni Supabase — lo cargan los tests.
 */
import { fichaOperativa, paisDeTelefonoOperativo } from "./ficha-operativa.ts"
import { rutEnTexto, rucEnTexto } from "../rut.ts"
import { nitEnTexto } from "./co/nit.ts"
import { rfcEnTexto } from "./mx/rfc.ts"

const EXTRACTOR_POR_DOCUMENTO: Record<string, (texto: string) => string | null> = {
  RUT: rutEnTexto,
  RUC: rucEnTexto,
  NIT: nitEnTexto,
  RFC: rfcEnTexto,
}

/** Primer documento VÁLIDO del país en el texto (canónico: como lo guarda el CRM), o null. */
export function documentoEnTexto(pais: string | null | undefined, texto: string): string | null {
  const etiqueta = fichaOperativa(pais).documento.etiqueta
  const fn = EXTRACTOR_POR_DOCUMENTO[etiqueta]
  return fn ? fn(String(texto || "")) : null
}

/** Lo mismo, con el país deducido del teléfono del contacto (prefijo desconocido = Chile, como siempre). */
export function documentoDeContactoEnTexto(contact: string | null | undefined, texto: string): string | null {
  return documentoEnTexto(paisDeTelefonoOperativo(contact) || "cl", texto)
}

/** Etiqueta del documento del país ("RUT"/"RUC"/"NIT"/"RFC"), para logs y textos. */
export function etiquetaDocumento(pais: string | null | undefined): string {
  return fichaOperativa(pais).documento.etiqueta
}
