/**
 * El mudo es un BUZÓN, no un apagón (04-sep).
 *
 * Dos invariantes que si se rompen dejan de cumplir lo pedido:
 *  1. va DESPUÉS de transcribir voz y describir adjuntos — si no, el material
 *     que se reenvía llega al historial como "__audio__" y no sirve de nada;
 *  2. va ANTES de markUserActivity/resetLoop — si no, cada reenvío re-ancla la
 *     cadencia y Vicky termina mandando un toque a los 10 minutos: justo lo que
 *     el mudo venía a evitar.
 *
 * Inspección: el webhook no es importable (arrastra Botmaker, Zoho y Supabase).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const RUTA = readFileSync("app/api/vic-botmaker-v3/route.ts", "utf8")
const HELPER = readFileSync("lib/mudo-contacto.ts", "utf8")

test("el mudo corre después de transcribir la voz y describir el adjunto", () => {
  const audio = RUTA.indexOf("const transcript = await transcribirAudio(audioUrl)")
  const adjunto = RUTA.indexOf("const descripcion = await describirImagen(mediaUrlEntrante)")
  const mudo = RUTA.indexOf("if (await contactoEnMudo(contact))")
  assert.ok(audio > 0 && adjunto > 0 && mudo > 0)
  assert.ok(mudo > audio, "el mudo no puede cortar antes de transcribir la nota de voz")
  assert.ok(mudo > adjunto, "el mudo no puede cortar antes de describir la captura o el PDF")
})

test("el mudo corre antes de la maquinaria proactiva", () => {
  const mudo = RUTA.indexOf("if (await contactoEnMudo(contact))")
  const actividad = RUTA.indexOf("await markUserActivity(contact)")
  const reset = RUTA.indexOf("resetLoop(contact, message)")
  assert.ok(actividad > mudo, "markUserActivity re-anclaría la cadencia de un reenvío")
  assert.ok(reset > mudo, "resetLoop agendaría un toque a los 10 minutos")
})

test("el mudo guarda el mensaje aunque no responda", () => {
  const i = RUTA.indexOf("if (await contactoEnMudo(contact))")
  const bloque = RUTA.slice(i, i + 700)
  assert.ok(bloque.includes("appendTurnV3"), "sin persistir, el buzón no sirve para leerlo después")
  assert.ok(bloque.includes('reply: ""'), "no puede salir texto al contacto")
})

test("el vencimiento vive en el valor y tiene tope de 12 horas", () => {
  assert.ok(HELPER.includes("MUDO_MAX_HORAS = 12"))
  assert.ok(HELPER.includes("t > Date.now()"), "se compara contra el reloj, no contra expires_at")
  assert.ok(HELPER.includes("MUDO_MAX_HORAS)"), "las horas se acotan al tope")
})

test("ante un fallo de lectura, Vicky responde (fail-open)", () => {
  const i = HELPER.indexOf("export async function contactoEnMudo")
  assert.ok(HELPER.slice(i, i + 400).includes("return false"), "un error de kv jamás debe enmudecer a un cliente")
})
