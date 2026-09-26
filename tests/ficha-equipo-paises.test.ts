import { test } from "node:test"
import assert from "node:assert/strict"
import { fichaRelojUrlDe, enviarFichaReloj } from "../lib/tools/enviar-ficha-reloj.ts"

// 26-sep (Lalo "agrega lo que falte de cada país, ¿falta ficha técnica de equipo?"):
// los cuatro países tienen ficha del equipo; ninguno responde "sin capacidad".
test("cada país tiene ficha técnica del equipo", () => {
  for (const p of ["cl", "pe", "co", "mx"]) {
    const url = fichaRelojUrlDe(p)
    assert.ok(url && /^https:\/\/cotizacion\.geovictoria\.com\/pdf\/assets\/ficha-reloj-senseface/.test(url), p)
  }
})

test("PE, CO y MX comparten el SenseFace 2A; Chile el 4A", () => {
  assert.equal(fichaRelojUrlDe("co"), fichaRelojUrlDe("pe"))
  assert.equal(fichaRelojUrlDe("mx"), fichaRelojUrlDe("pe"))
  assert.match(String(fichaRelojUrlDe("cl")), /4a/)
})

test("el mensaje nombra el equipo como se llama en cada país", async () => {
  const co = await enviarFichaReloj({ pais: "co" })
  const mx = await enviarFichaReloj({ pais: "mx" })
  assert.ok(co.ok && mx.ok)
  if (co.ok) assert.match(co.mensajeParaProspecto, /equipo biométrico/)
  if (mx.ok) assert.match(mx.mensajeParaProspecto, /reloj checador/)
})
