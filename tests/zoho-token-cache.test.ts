/**
 * El caché del token de Zoho inventaba vida que el token no tenía.
 *
 * CASO REAL (27-jul 14:19, Andirent +573112895086): Vicky agendó la reunión,
 * Cal.com la aceptó, y crear el Lead en Zoho devolvió
 *
 *   {"code":"INVALID_TOKEN","message":"invalid oauth token","status":"error"}
 *
 * Siete minutos antes, otra función del mismo deploy había hecho un update de
 * Lead con el MISMO token sin problema. O sea: el refresh token estaba bien.
 *
 * El bug estaba en getZohoAccessToken. La lectura de Supabase filtra por
 * `expires_at > now()`, así que puede devolver un token con diez segundos de
 * vida; y quien lo recibía le estampaba `now + 50 min` en el caché de proceso,
 * ignorando el vencimiento real. Esa instancia servía un token muerto durante
 * casi una hora sin intentar renovarlo nunca.
 *
 * Por qué parecía un problema de país: cada función serverless
 * (vic-botmaker-v3, vic-botmaker-co, cada cron) tiene sus propias instancias
 * calientes y su propio caché en memoria. Una podía tener token fresco y la de
 * al lado uno vencido, al mismo tiempo. No tenía nada de colombiano.
 *
 * Estos tests son sobre el archivo, no de ejecución: getZohoAccessToken llama
 * a Supabase y a Zoho, y no vale la pena montar ese doble para tres reglas.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const RAIZ = new URL("..", import.meta.url).pathname
const SRC = readFileSync(join(RAIZ, "lib/zoho-token.ts"), "utf8")

describe("el caché del token respeta el vencimiento real", () => {
  test("la lectura de Supabase trae expires_at, no solo el valor", () => {
    assert.match(SRC, /select=value,expires_at/)
    assert.match(SRC, /Promise<\{ token: string; expiresAt: number \} \| null>/)
  })

  test("NUNCA se inventa una fecha de vencimiento al leer del caché", () => {
    // Esta era la línea del bug:  _cache.expiresAt = now + 50 * 60 * 1000
    // justo después de leer de Supabase.
    const bloque = SRC.slice(
      SRC.indexOf("const cached = await readTokenFromSupabase()"),
      SRC.indexOf("// 3. Renovar token"),
    )
    assert.ok(bloque.length > 0, "cambió la estructura de getZohoAccessToken")
    assert.doesNotMatch(
      bloque,
      /_cache\.expiresAt\s*=\s*now\s*\+/,
      "volvió a estampar una vida inventada sobre el token cacheado",
    )
    assert.match(bloque, /_cache\.expiresAt = cached\.expiresAt/)
  })

  test("un token con poca vida se descarta y se renueva", () => {
    assert.match(SRC, /cached && cached\.expiresAt - now > 2 \* 60 \* 1000/)
  })

  test("el margen del caché en proceso sigue siendo el mismo", () => {
    // Las dos puertas usan el mismo umbral de 2 minutos: si difieren, hay una
    // ventana por la que se cuela un token a punto de morir.
    const umbrales = [...SRC.matchAll(/expiresAt\s*-\s*now\s*>\s*2 \* 60 \* 1000/g)]
    assert.equal(umbrales.length, 2, "las dos puertas del caché deben usar el mismo margen")
  })

  test("al renovar sí se puede estampar la vida, porque el token es nuevo", () => {
    // 55 min sobre los 60 reales de Zoho: 5 de margen. Eso está bien.
    const bloque = SRC.slice(SRC.indexOf("// 3. Renovar token"))
    assert.match(bloque, /_cache\.expiresAt = now \+ 55 \* 60 \* 1000/)
  })
})
