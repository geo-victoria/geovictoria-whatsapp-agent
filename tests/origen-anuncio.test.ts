import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizarReferral, camposDeOrigen, camposFaltantes, LEAD_SOURCE_META_ADS } from "../lib/origen-anuncio.ts"

test("referral en camelCase (acción de código) y snake_case (Meta crudo)", () => {
  const a = normalizarReferral({ sourceId: "120212", sourceType: "ad", headline: "Control de asistencia", ctwaClid: "ARAk1" }, "T")
  assert.equal(a?.sourceId, "120212")
  assert.equal(a?.ctwaClid, "ARAk1")
  const b = normalizarReferral({ referral: { source_id: "999", source_type: "ad", source_url: "https://fb.me/x", ctwa_clid: "C1" } }, "T")
  assert.equal(b?.sourceId, "999")
  assert.equal(b?.sourceUrl, "https://fb.me/x")
  assert.equal(normalizarReferral(JSON.stringify({ source_id: "7", source_type: "ad" }), "T")?.sourceId, "7")
})

test("sin anuncio no hay origen: vacío, post orgánico o basura", () => {
  assert.equal(normalizarReferral(undefined), null)
  assert.equal(normalizarReferral({}), null)
  assert.equal(normalizarReferral({ source_id: "5", source_type: "story" }), null)
  assert.equal(normalizarReferral("no es json"), null)
})

test("campos del lead: Meta Ads, id del anuncio, clic y campaña", () => {
  const o = normalizarReferral({ sourceId: "120212", sourceType: "ad", headline: "Asistencia", ctwaClid: "ARAk1" }, "T")!
  assert.deepEqual(camposDeOrigen(o, "Meta_Click_ID"), {
    Lead_Source: LEAD_SOURCE_META_ADS, Medium: "whatsapp_ads", Meta_Ad_ID: "120212", Campaign: "Asistencia", Meta_Click_ID: "ARAk1",
  })
  assert.equal("Meta_Click_ID" in camposDeOrigen(o, "-"), false)
})

test("lead existente: solo lo vacío, un Lead_Source con origen no se pisa", () => {
  const deseados = { Lead_Source: LEAD_SOURCE_META_ADS, Medium: "whatsapp_ads", Meta_Ad_ID: "1" }
  assert.deepEqual(camposFaltantes({ Lead_Source: "14. Google Ads", Medium: null, Meta_Ad_ID: "" }, deseados), { Medium: "whatsapp_ads", Meta_Ad_ID: "1" })
  assert.deepEqual(camposFaltantes({ Lead_Source: "-None-" }, { Lead_Source: LEAD_SOURCE_META_ADS }), { Lead_Source: LEAD_SOURCE_META_ADS })
})

test("forma real de Botmaker 30-sep: message.referralInfo con sourceType post y clic vacío", () => {
  const msg = { MESSAGE: "¡Hola! Quiero más información", referralInfo: { sourceId: "1717365150390756", sourceURL: "https://fb.me/eaLcgPadl", ctwaClid: "", sourceType: "post", type: "whatsapp", body: "", headline: "Chatea con nosotros" } }
  const o = normalizarReferral({ sourceId: msg.referralInfo.sourceId, sourceType: "post", sourceUrl: msg.referralInfo.sourceURL, headline: msg.referralInfo.headline, ctwaClid: "" }, "T")!
  assert.equal(o.sourceId, "1717365150390756")
  assert.deepEqual(camposDeOrigen(o, "Meta_Click_ID"), { Lead_Source: LEAD_SOURCE_META_ADS, Medium: "whatsapp_ads", Meta_Ad_ID: "1717365150390756", Campaign: "Chatea con nosotros" })
})
