#!/usr/bin/env python3
"""
Genera el Radar MRR (dashboard HTML cifrado) desde el export mensual.

Toma "MRR_consolidado_YYYYMM.xlsx" (pestañas 'Facturación x Producto USD' y
'Facturación x Producto MonLocal'), aplica las fusiones de conglomerados
validadas y produce un HTML autocontenido con:

  - pestaña Global + una pestaña por país (Chile, Colombia, México, Perú,
    Argentina, Otros países)
  - KPIs, series, NRR en moneda local, puente del crecimiento (waterfall),
    cuentas en riesgo, fugas, alertas y recomendaciones por reglas
  - asistente de datos local
  - datos cifrados con AES-256-GCM: sin la clave el HTML no revela nada

Uso:
    python analysis/mrr/radar/build_radar.py MRR_consolidado_202608.xlsx \
        -o radar_mrr.html --clave 'LaClave'          # o export RADAR_CLAVE=...

Luego el HTML se publica en la URL existente del panel: subirlo a una
conversación de Claude y pedir "publica este archivo en la URL del Radar MRR",
pegando la URL del artifact. La clave puede cambiarse en cada corrida.

Requiere: pandas, numpy, openpyxl, cryptography.
"""
import argparse, base64, json, os, sys, unicodedata
import numpy as np
import pandas as pd

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(AQUI))
from monitoreo_mrr import cargar_fusiones, corregir_conglomerado, es_codigo, nombre_bonito  # noqa: E402

import re  # noqa: E402

MAIN = ["CHILE", "COLOMBIA", "MÉXICO", "PERÚ", "ARGENTINA"]
OTROS_P = ["PANAMÁ", "ESPAÑA", "BRASIL", "URUGUAY"]
TITULO = {"CHILE": "Chile", "COLOMBIA": "Colombia", "MÉXICO": "México", "PERÚ": "Perú",
          "ARGENTINA": "Argentina", "OTROS": "Otros países", "PANAMÁ": "Panamá",
          "ESPAÑA": "España", "BRASIL": "Brasil", "URUGUAY": "Uruguay"}
UMBRAL_RIESGO_USD = 500
CONTRACCION_RIESGO = 0.22

# Hallazgos estructurales del análisis ago-2026 (no se recalculan cada mes)
ESTACIONALIDAD = ("La fuga de MRR se concentra en cierres de trimestre (mar, jun, sep, dic "
                  "≈ US$14,5–15,3k/mes vs ~US$10k resto); las altas peak en may–jul (análisis ago-2026).")
PARTNERS = ("8 partners activos = 6,6% del MRR y 9,5% del crecimiento interanual. "
            "Visma es el mayor (4,0% del MRR) (análisis ago-2026).")
TICKET = ("El ticket de entrada se mantiene plano (mediana US$44→51 por logo nuevo); "
          "la mejora de las cosechas viene de retención, no de vender más grande (análisis ago-2026).")


def es(v, d=1):
    t = f"{v:,.{d}f}"
    return t.replace(",", "X").replace(".", ",").replace("X", ".")


def es0(v):
    return es(v, 0)


def detectar_sin_carga(df, mcols):
    ult, ant = mcols[-1], mcols[-2]
    p = df["País"].astype(str).str.strip()
    sin = set()
    act_ant = df[df[ant] > 0].groupby(p).size()
    act_ult = df[df[ult] > 0].groupby(p).size()
    for pais, n_ant in act_ant.items():
        if n_ant >= 20 and act_ult.get(pais, 0) < 0.1 * n_ant:
            sin.add(pais)
    return sin


def aplicar_sin_carga(df, mcols, sin):
    ult, ant = mcols[-1], mcols[-2]
    df = df.copy()
    m = df["País"].astype(str).str.strip().isin(sin) & (df[ult].isna() | (df[ult] == 0))
    df.loc[m, ult] = df.loc[m, ant]
    return df


def cifrar(datos: bytes, clave: str) -> dict:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes
    it = 310000
    salt, iv = os.urandom(16), os.urandom(12)
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=it)
    key = kdf.derive(clave.encode())
    ct = AESGCM(key).encrypt(iv, datos, None)  # ct || tag
    b64 = lambda b: base64.b64encode(b).decode()
    return {"v": 1, "it": it, "s": b64(salt), "i": b64(iv), "c": b64(ct)}


def main():
    ap = argparse.ArgumentParser(description="Genera el Radar MRR (HTML cifrado)")
    ap.add_argument("xlsx", help="export mensual MRR_consolidado_YYYYMM.xlsx")
    ap.add_argument("-o", "--salida", default="radar_mrr.html")
    ap.add_argument("--clave", default=os.environ.get("RADAR_CLAVE"),
                    help="clave de acceso (o variable de entorno RADAR_CLAVE)")
    ap.add_argument("--json", help="además, volcar los datos sin cifrar a este archivo (debug)")
    ap.add_argument("--artifact", action="store_true",
                    help="salida como fragmento (sin <!doctype>/<head>), para publicar como artifact de Claude; "
                         "por defecto se genera un documento HTML completo (Vercel / archivo suelto)")
    args = ap.parse_args()
    if not args.clave:
        ap.error("falta la clave: --clave o RADAR_CLAVE")

    fusiones = cargar_fusiones()
    usd = pd.read_excel(args.xlsx, sheet_name="Facturación x Producto USD")
    loc = pd.read_excel(args.xlsx, sheet_name="Facturación x Producto MonLocal")
    mcols = [c for c in usd.columns if re.match(r"^[a-z]+-20\d\d$", str(c))]
    N = len(mcols)
    ult, m0 = mcols[-1], mcols[-13]
    rec3, prev3 = mcols[-3:], mcols[-9:-6]
    print(f"meses: {mcols[0]} .. {ult} ({N})")

    sin_carga = detectar_sin_carga(usd, mcols)
    if sin_carga:
        print(f"  aviso: países sin carga en {ult}, usando {mcols[-2]}: {sorted(sin_carga)}")
    usd = aplicar_sin_carga(usd, mcols, sin_carga)
    loc = aplicar_sin_carga(loc, mcols, sin_carga)

    for df in (usd, loc):
        df["CG"] = df.apply(lambda r: corregir_conglomerado(r, fusiones), axis=1)
        df["_p"] = df["País"].astype(str).str.strip()

    MU = usd.groupby("CG")[mcols].sum().clip(lower=0)
    usd["_t"] = usd[mcols].sum(axis=1)
    top = usd.sort_values("_t", ascending=False).drop_duplicates("CG").set_index("CG")
    pais, indus, cliente = top["_p"], top["Industria"], top["Cliente"]
    nombre = {cg: (nombre_bonito(cliente[cg]) if es_codigo(cg) else cg) for cg in MU.index}
    MUC = {p: g.groupby("CG")[mcols].sum().clip(lower=0) for p, g in usd.groupby("_p")}
    ML = {p: g.groupby("CG")[mcols].sum().clip(lower=0) for p, g in loc.groupby("_p")}
    col_mon = next((c for c in loc.columns if str(c).strip().upper() == "MONEDA"), None)
    moneda = (loc.groupby("_p")[col_mon].agg(lambda s: s.mode().iat[0]).to_dict()
              if col_mon else {})

    def nrr_pair(paises, i0, i1):
        a, b = mcols[i0], mcols[i1]
        num = den = 0.0
        nu = du = 0.0
        for p in paises:
            if p not in MUC or p not in ML:
                continue
            U, L = MUC[p], ML[p]
            cu, cl = U[U[a] > 0], L[L[a] > 0]
            if len(cl) == 0 or cl[a].sum() <= 0:
                continue
            w = float(cu[a].sum())
            num += float(cl[b].sum() / cl[a].sum()) * w
            den += w
            nu += float(cu[b].sum())
            du += float(cu[a].sum())
        if den <= 0:
            return None, None
        return round(num / den * 100, 1), round(nu / du * 100, 1)

    def puente(M):
        coh = M[M[m0] > 0]
        fu = coh[(coh[rec3] <= 0).all(axis=1)]
        alive = coh.drop(fu.index)
        d = alive[ult] - alive[m0]
        return {"start": float(coh[m0].sum()), "nuevo": float(M[M[m0] <= 0][ult].sum()),
                "exp": float(d.clip(lower=0).sum()), "contr": float((-d).clip(lower=0).sum()),
                "fuga": float(fu[m0].sum()), "end": float(M[ult].sum())}

    # ---------------- pestañas por país ----------------
    def build_tab(key, paises):
        pres = [p for p in paises if p in MUC]
        U = pd.concat([MUC[p] for p in pres]) if len(pres) > 1 else MUC[pres[0]]
        U = U.groupby(U.index).sum()
        mrr_serie = [round(float(U[m].sum()) / 1000, 1) for m in mcols]
        act_serie = [int((U[m] > 0).sum()) for m in mcols]
        nrr_serie = [{"m": mcols[i], "loc": (lo := nrr_pair(pres, i - 12, i))[0], "usd": lo[1]}
                     for i in range(12, N)]
        coh = U[U[m0] > 0]
        fuga = coh[(coh[rec3] <= 0).all(axis=1)]
        fuga_k = float(fuga[m0].sum()) / 1000
        first = (U[mcols] > 0).idxmax(axis=1)
        has = (U[mcols] > 0).any(axis=1)
        nuevos = U[has & first.isin(mcols[-12:]) & (U[ult] > 0)]
        Ls = {p: ML[p] for p in pres if p in ML}

        def d12_local(cg):
            for p in pres:
                L = Ls.get(p)
                if L is not None and cg in L.index and L.loc[cg, m0] > 0:
                    return round(float(L.loc[cg, ult] / L.loc[cg, m0] - 1) * 100, 1)
            return None

        # matriz local del país (solo pestañas de un país; en mezclas no hay moneda común)
        L1 = Ls.get(pres[0]) if len(pres) == 1 else None

        def lval(cg, col):
            if L1 is not None and cg in L1.index:
                return round(float(L1.loc[cg, col]))
            return None

        tot_ult = float(U[ult].sum())
        top_rows = [{"n": nombre[cg], "ind": str(indus.get(cg, ""))[:26],
                     "mrr": round(float(U.loc[cg, ult])), "mrr_loc": lval(cg, ult),
                     "share": round(float(U.loc[cg, ult]) / tot_ult * 100, 1),
                     "d12": d12_local(cg)}
                    for cg in U[ult].sort_values(ascending=False).head(12).index]
        top10_share = round(float(U[ult].sort_values(ascending=False).head(10).sum()) / tot_ult * 100, 1)

        riesgo = []
        for cg in U[(U[ult] > 0) & (U[rec3].mean(axis=1) >= UMBRAL_RIESGO_USD)].index:
            for p in pres:
                L = Ls.get(p)
                if L is not None and cg in L.index:
                    a, b = float(L.loc[cg, rec3].mean()), float(L.loc[cg, prev3].mean())
                    if b > 0 and a / b <= 1 - CONTRACCION_RIESGO:
                        riesgo.append({"n": nombre[cg], "ind": str(indus.get(cg, ""))[:26],
                                       "mrr": round(float(U.loc[cg, rec3].mean())),
                                       "mrr_loc": round(a) if L1 is not None else None,
                                       "ca": round((1 - a / b) * 100, 1)})
                    break
        riesgo = sorted(riesgo, key=lambda r: -r["mrr"])
        fugas = [{"n": nombre[cg], "ind": str(indus.get(cg, ""))[:26], "mrr": round(float(fuga.loc[cg, m0])),
                  "mrr_loc": lval(cg, m0)}
                 for cg in fuga[m0].sort_values(ascending=False).head(10).index]

        it = {}
        for cg in U[U[ult] > 0].index:
            i = str(indus.get(cg, "Otros"))
            it.setdefault(i, [0.0, 0.0, 0.0])
            it[i][0] += float(U.loc[cg, ult])
            it[i][1] += float(U.loc[cg, m0])
            it[i][2] += (lval(cg, ult) or 0)
        industrias = [{"ind": k, "mrr": round(v[0] / 1000, 1), "share": round(v[0] / tot_ult * 100, 1),
                       "mrr_loc": (round(v[2]) if L1 is not None else None),
                       "yoy": (round((v[0] / v[1] - 1) * 100, 1) if v[1] > 0 else None)}
                      for k, v in sorted(it.items(), key=lambda kv: -kv[1][0])[:6]]

        mom_num = mom_den = 0.0
        for p in pres:
            L = Ls.get(p)
            if L is None:
                continue
            a, b = float(L[rec3].sum().sum()) / 3, float(L[prev3].sum().sum()) / 3
            if b > 0:
                w = float(MUC[p][rec3].sum().sum()) / 3
                mom_num += (a / b - 1) * w
                mom_den += w
        momentum = round(mom_num / mom_den * 100, 1) if mom_den else 0.0
        yl_num = yl_den = 0.0
        for p in pres:
            L = Ls.get(p)
            if L is None:
                continue
            a0, a1 = float(L[m0].sum()), float(L[ult].sum())
            if a0 > 0:
                w = float(MUC[p][m0].sum())
                yl_num += (a1 / a0 - 1) * w
                yl_den += w
        yoy_loc = round(yl_num / yl_den * 100, 1) if yl_den else None
        nrr_loc, nrr_usd = nrr_pair(pres, N - 13, N - 1)
        kpis = {"mrr": mrr_serie[-1], "yoy": round((float(U[ult].sum() / U[m0].sum()) - 1) * 100, 1),
                "yoy_loc": yoy_loc,
                "activos": act_serie[-1], "nrr_loc": nrr_loc, "nrr_usd": nrr_usd,
                "fuga_n": int(len(fuga)), "fuga_k": round(fuga_k, 1),
                "fuga_pct": round(fuga_k * 1000 / float(coh[m0].sum()) * 100, 1) if coh[m0].sum() > 0 else 0,
                "top10": top10_share, "nuevos": int(len(nuevos)),
                "nuevos_k": round(float(nuevos[ult].sum()) / 1000, 1), "momentum": momentum,
                "riesgo_n": int(len(riesgo)), "riesgo_usd": int(sum(r["mrr"] for r in riesgo))}
        bridge = {"usd": puente(U),
                  "loc": puente(ML[pres[0]]) if len(pres) == 1 and pres[0] in ML else None,
                  "mon": moneda.get(pres[0], "") if len(pres) == 1 else None}
        sub = None
        if len(pres) > 1:
            sub = []
            for p in pres:
                Up = MUC[p]
                Lp = ML.get(p)
                lo, _ = nrr_pair([p], N - 13, N - 1)
                yl = None
                if Lp is not None and float(Lp[m0].sum()) > 0:
                    yl = round((float(Lp[ult].sum() / Lp[m0].sum()) - 1) * 100, 1)
                sub.append({"pais": TITULO.get(p, p.title()), "mrr": round(float(Up[ult].sum()) / 1000, 1),
                            "activos": int((Up[ult] > 0).sum()),
                            "yoy": round((float(Up[ult].sum() / Up[m0].sum()) - 1) * 100, 1) if Up[m0].sum() > 0 else None,
                            "yoy_loc": yl, "nrr_loc": lo})
        # totales en moneda local para el selector US$/local del panel
        mon = moneda.get(pres[0], "") if len(pres) == 1 else None
        mrr_serie_loc = kpis_loc = None
        if L1 is not None:
            mrr_serie_loc = [round(float(L1[m].sum())) for m in mcols]
            kpis_loc = {"mrr": mrr_serie_loc[-1],
                        "fuga": int(sum(lval(cg, m0) or 0 for cg in fuga.index)),
                        "nuevos": int(sum(lval(cg, ult) or 0 for cg in nuevos.index))}
        return {"titulo": TITULO[key], "kpis": kpis, "mrr_serie": mrr_serie, "act_serie": act_serie,
                "nrr_serie": nrr_serie, "top": top_rows, "riesgo": riesgo[:10], "fugas": fugas,
                "industrias": industrias, "sub": sub, "bridge": bridge,
                "mon": mon, "mrr_serie_loc": mrr_serie_loc, "kpis_loc": kpis_loc}

    tabs = {p: build_tab(p, [p]) for p in MAIN}
    otros_reales = [p for p in sorted(MUC) if p not in MAIN]
    tabs["OTROS"] = build_tab("OTROS", otros_reales or OTROS_P)

    # ---------------- alertas y recomendaciones ----------------
    def alerts_for(t, key):
        k = t["kpis"]
        A, R = [], []
        nl = k["nrr_loc"]
        if nl is not None:
            if nl < 100:
                A.append({"s": "crit", "t": f"NRR {es(nl)}% en moneda local", "d":
                          "La base instalada de hace 12 meses factura hoy menos que entonces: el crecimiento depende 100% de ventas nuevas."})
            elif nl < 107:
                A.append({"s": "warn", "t": f"NRR {es(nl)}% en moneda local", "d":
                          "Retención neta positiva pero lejos del 115% sano: la expansión apenas cubre fuga y contracción."})
            else:
                A.append({"s": "ok", "t": f"NRR {es(nl)}% en moneda local", "d":
                          "La base instalada crece por sí sola. Mantener el playbook de expansión."})
        if k["fuga_pct"] >= 12:
            A.append({"s": "crit", "t": f"Fuga 12m: {es(k['fuga_pct'])}% del MRR ({es0(k['fuga_n'])} cuentas)", "d":
                      "Muy por sobre el promedio de la compañía. Revisar causas raíz con el equipo de CS."})
        elif k["fuga_pct"] >= 8:
            A.append({"s": "warn", "t": f"Fuga 12m: {es(k['fuga_pct'])}% del MRR ({es0(k['fuga_n'])} cuentas)", "d":
                      "Sobre el promedio de la compañía."})
        if t["riesgo"]:
            tot_r = sum(r["mrr"] for r in t["riesgo"])
            names = ", ".join(r["n"] for r in t["riesgo"][:3])
            sev = "crit" if tot_r > k["mrr"] * 1000 * 0.03 else "warn"
            A.append({"s": sev, "t": f"{k['riesgo_n']} cuentas grandes en contracción", "d":
                      f"US$ {es0(tot_r)}/mes cayendo ≥22% en moneda local ({names}…). Este patrón precede a la fuga: intervenir ahora."})
            R.append(f"Agendar QBR con {names.split(',')[0].strip()} este mes: la contracción sostenida en moneda local es la señal que precedió a las fugas grandes (caso RedSalud).")
        if k["momentum"] <= -3:
            A.append({"s": "warn", "t": f"MRR local cayendo {es(abs(k['momentum']))}% (últimos 3 meses vs. trimestre anterior)", "d":
                      "El momentum reciente es negativo en moneda local, aún si el número en USD se ve estable."})
        if k["top10"] >= 40:
            A.append({"s": "warn", "t": f"Concentración: top 10 = {es(k['top10'])}% del MRR", "d":
                      "Una fuga grande movería fuerte el país. Formalizar planes de cuenta para el top 10."})
        if k["yoy"] >= 25 and (nl or 0) >= 100:
            A.append({"s": "ok", "t": f"Crecimiento +{es(k['yoy'])}% interanual", "d":
                      f"{es0(k['nuevos'])} logos nuevos aportan US$ {es(k['nuevos_k'])} k/mes."})
        if nl is not None and nl < 107:
            R.append("Subir NRR con expansión en la base: los productos de asistencia y casino tienen espacio de cross-sell en cuentas que solo usan control de asistencia.")
        if k["fuga_pct"] >= 8 or k["fuga_n"] > 50:
            R.append("La fuga se concentra en cuentas chicas: automatizar onboarding y cobranza temprana; el 80% chico fuga 2–3× más que el 20% grande.")
        if k["nuevos_k"] < k["fuga_k"]:
            R.append(f"Las altas de 12 meses (US$ {es(k['nuevos_k'])} k) no cubren la fuga (US$ {es(k['fuga_k'])} k): el crecimiento depende de expansión, no de logos nuevos.")
        if key == "CHILE" and nl is not None and k["nrr_usd"] is not None and k["nrr_usd"] - nl >= 3:
            R.append(f"Renegociar en pesos con cláusula de reajuste: parte del NRR USD ({es(k['nrr_usd'])}%) es efecto cambiario, no expansión real ({es(nl)}% local).")
        if key == "ARGENTINA":
            A.insert(0, {"s": "warn", "t": "Leer el NRR local con cuidado: incluye inflación", "d":
                         "En Argentina los reajustes de precio en pesos siguen a la inflación, así que el NRR en moneda local viene inflado. Acá conviene mirar también el NRR en USD."})
            R.append("Formalizar cláusulas de reajuste indexadas: hoy el crecimiento depende de renegociaciones caso a caso.")
        return A, R

    for key, t in tabs.items():
        t["alerts"], t["recs"] = alerts_for(t, key)

    # ---------------- global (rep) ----------------
    total = [round(float(MU[m].sum()) / 1000, 1) for m in mcols]
    pais_s = pd.Series(pais).reindex(MU.index)
    country_series = {}
    for p in MAIN:
        Mp = MUC.get(p)
        country_series[p] = [round(float(Mp[m].sum()) / 1000, 1) for m in mcols] if Mp is not None else [0] * N
    ot = [MUC[p] for p in otros_reales]
    country_series["OTROS"] = [round(sum(float(Mp[m].sum()) for Mp in ot) / 1000, 1) for m in mcols]

    ind_s = pd.Series(indus).reindex(MU.index).astype(str)
    by_ind = MU[ult].groupby(ind_s).sum().sort_values(ascending=False)
    tot26 = float(by_ind.sum())
    industry = [{"ind": i, "jul26": round(float(by_ind[i]) / 1000, 1),
                 "share": round(float(by_ind[i]) / tot26 * 100, 1)} for i in by_ind.index[:14]]

    todos = sorted(MUC)
    nrr_rows = []
    for i in range(12, N):
        a, b = mcols[i - 12], mcols[i]
        coh = MU[MU[a] > 0]
        B, A_ = float(coh[a].sum()), float(coh[b].sum())
        grr = float(np.minimum(coh[b], coh[a]).sum())
        lo, _us = nrr_pair(todos, i - 12, i)
        nrr_rows.append({"m": b, "nrr": round(A_ / B * 100, 1), "grr": round(grr / B * 100, 1),
                         "nrr_local": lo})

    coh = MU[MU[m0] > 0]
    fuga_g = coh[(coh[rec3] <= 0).all(axis=1)]
    nrr_loc_g, _ = nrr_pair(todos, N - 13, N - 1)
    nrr_usd_g = round(float(coh[ult].sum() / coh[m0].sum()) * 100, 1)  # cohorte global en USD
    top10_g = round(float(MU[ult].sort_values(ascending=False).head(10).sum() / MU[ult].sum()) * 100, 1)
    gl_num = gl_den = 0.0
    for p in todos:
        Lp = ML.get(p)
        if Lp is None or float(Lp[m0].sum()) <= 0:
            continue
        w = float(MUC[p][m0].sum())
        gl_num += (float(Lp[ult].sum() / Lp[m0].sum()) - 1) * w
        gl_den += w
    yoy_local_g = round(gl_num / gl_den * 100, 1) if gl_den else None
    kpi = {"mrr": total[-1], "yoy": round((float(MU[ult].sum() / MU[m0].sum()) - 1) * 100, 1),
           "yoy_local": yoy_local_g,
           "activos": int((MU[ult] > 0).sum()), "nrr": nrr_usd_g, "nrr_local": nrr_loc_g,
           "churn_mrr_12m": round(float(fuga_g[m0].sum() / coh[m0].sum()) * 100, 1),
           "top10_share": top10_g, "arr": round(total[-1] * 12 / 1000, 1)}

    # fugas históricas: sin facturación en los últimos 3 meses; MRR = promedio de sus últimos 3 meses facturados
    hist = MU[(MU[rec3] <= 0).all(axis=1) & (MU[mcols].sum(axis=1) > 0)]
    tc = []
    for cg in hist.index:
        v = hist.loc[cg, mcols]
        pos = v[v > 0]
        if len(pos):
            tc.append((cg, float(pos.tail(3).mean())))
    tc.sort(key=lambda x: -x[1])
    top_churn = [{"cg": nombre[cg], "pais": str(pais_s.get(cg, "")),
                  "ind": str(indus.get(cg, "")), "mrr": round(v)} for cg, v in tc[:12]]

    # 80/20 de la cohorte actual (para la alerta y la tarjeta)
    thr = float(coh[m0].quantile(0.8))
    chicas = set(coh[coh[m0] <= thr].index)
    grandes = set(coh.index) - chicas

    def seg_loc(seg):
        num = den = 0.0
        for p in todos:
            if p not in ML:
                continue
            U, L = MUC[p], ML[p]
            cu = U[(U[m0] > 0) & U.index.isin(seg)]
            cl = L[(L[m0] > 0) & L.index.isin(seg)]
            if len(cl) == 0 or cl[m0].sum() <= 0:
                continue
            w = float(cu[m0].sum())
            num += float(cl[ult].sum() / cl[m0].sum()) * w
            den += w
        return round(num / den * 100, 1) if den else None

    c_loc = seg_loc(chicas)
    share_g = round(float(coh.loc[list(grandes), m0].sum() / coh[m0].sum()) * 100)
    m8020 = (f"El 20% de cuentas más grandes concentra ~{es0(share_g)}% del MRR y retiene bien. "
             f"El 80% chico (hasta ~US$ {es0(thr)}/mes) tiene NRR local ≈ {es(c_loc)}% y pierde 15–16% de logos al año: "
             "ahí vive casi toda la fuga. La estrategia de retención tiene dos velocidades: planes de cuenta arriba, automatización abajo.")

    riesgo_total = sum(t["kpis"]["riesgo_n"] for t in tabs.values())
    gap = kpi["nrr"] - kpi["nrr_local"] if kpi["nrr"] is not None and kpi["nrr_local"] is not None else 0
    galerts = [
        {"s": "warn", "t": f"NRR real {es(kpi['nrr_local'])}% en moneda local (USD: {es(kpi['nrr'])}%)", "d":
         f"Bajo el 115% sano. ~{es0(gap)} puntos del NRR en USD son efecto cambiario, no expansión real."},
        {"s": "warn", "t": f"Las cuentas chicas no se retienen: NRR local ≈ {es(c_loc)}%", "d":
         "El 80% más chico de la cartera (por nº de cuentas) tiene retención neta casi nula; el 20% grande sostiene el NRR."},
        {"s": "crit", "t": f"{riesgo_total} cuentas grandes en contracción sostenida", "d":
         "Patrón pre-fuga (RedSalud se contrajo 2 años antes de irse). Lista completa en cada pestaña de país."},
        {"s": "ok", "t": f"MRR US$ {es(kpi['mrr'])} k (+{es(kpi['yoy'])}% interanual)", "d":
         f"ARR ≈ US$ {es(kpi['arr'])} M con {es0(kpi['activos'])} conglomerados activos."},
    ]
    grecs = [
        f"Medir y comunicar NRR en moneda local como KPI oficial (el USD sobreestima ~{es0(gap)} pts).",
        "Programa de retención para el segmento chico: onboarding automatizado + alerta de contracción; ahí se pierde 15–16% de logos al año.",
        f"Plan de cuenta formal para el top 10 ({es(kpi['top10_share'])}% del MRR) y QBR trimestral para toda cuenta > US$ 2.000/mes.",
        "Usar el monitoreo mensual (analysis/mrr) para revisar la lista 'En riesgo' en el comité comercial de cada mes.",
    ]

    # ---------------- índice del asistente ----------------
    idx = []
    act = MU[MU[ult] > 0][ult].sort_values(ascending=False)
    for cg in act.head(800).index:
        p = str(pais_s.get(cg, "")).strip()
        L = ML.get(p)
        d12 = None
        if L is not None and cg in L.index and L.loc[cg, m0] > 0:
            d12 = round(float(L.loc[cg, ult] / L.loc[cg, m0] - 1) * 100, 1)
        idx.append([nombre[cg], p.title(), str(indus.get(cg, ""))[:24], round(float(MU.loc[cg, ult])), d12, "activo"])
    fu12 = coh[(coh[rec3] <= 0).all(axis=1)][m0].sort_values(ascending=False)
    for cg in fu12.head(200).index:
        idx.append([nombre[cg], str(pais_s.get(cg, "")).strip().title(),
                    str(indus.get(cg, ""))[:24], round(float(fu12[cg])), None, "fugado"])

    convenciones = ["NRR siempre en moneda local (t.c. constante); USD solo referencia",
                    "Conglomerados corregidos (fusiones validadas, ver fusiones_conglomerados.csv)",
                    "Fuga = sin facturación en los últimos 3 meses"]
    if sin_carga:
        convenciones.append(f"{', '.join(sorted(sin_carga)).title()} sin carga en {ult}: se usa {mcols[-2]}")

    rep = {"months": mcols, "total": total, "country_series": country_series, "industry": industry,
           "nrr": nrr_rows, "top_churn": top_churn,
           "churn12_total": round(float(fuga_g[m0].sum()) / 1000, 1), "churn12_n": int(len(fuga_g)),
           "kpi": kpi}
    meta = {"cierre": ult, "meses": [mcols[0], ult], "convenciones": convenciones,
            "estacionalidad": ESTACIONALIDAD, "partners": PARTNERS, "ticket": TICKET, "m8020": m8020}
    out = {"tabs": tabs, "orden": ["GLOBAL"] + MAIN + ["OTROS"], "galerts": galerts, "grecs": grecs,
           "idx": idx, "meta": meta, "rep": rep, "gbridge": {"usd": puente(MU)}}

    datos = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    if args.json:
        open(args.json, "w").write(datos)
        print(f"datos sin cifrar -> {args.json}")

    tpl = open(os.path.join(AQUI, "template.html"), encoding="utf-8").read()
    A = os.path.join(AQUI, "assets")
    piezas = {
        "@@FONT_BS@@": open(f"{A}/brsonoma_sb.b64").read().strip(),
        "@@FONT_NR@@": open(f"{A}/nunito_Regular.b64").read().strip(),
        "@@FONT_NS@@": open(f"{A}/nunito_SemiBold.b64").read().strip(),
        "@@FONT_NB@@": open(f"{A}/nunito_Bold.b64").read().strip(),
        "@@LOGO@@": open(f"{A}/logo.svg.oneline").read().strip(),
        "@@ENC@@": json.dumps(cifrar(datos.encode(), args.clave)),
    }
    for k, v in piezas.items():
        assert k in tpl, f"falta {k} en template.html"
        tpl = tpl.replace(k, v)
    assert "@@" not in tpl
    if not args.artifact:
        # documento completo: el artifact de Claude agrega su propio esqueleto, pero
        # Vercel o un archivo suelto necesitan doctype/head propios
        m = re.match(r"\s*<title>(.*?)</title>", tpl)
        titulo = m.group(1) if m else "Radar MRR"
        cuerpo = tpl[m.end():] if m else tpl
        tpl = ('<!doctype html><html lang="es"><head><meta charset="utf-8">'
               '<meta name="viewport" content="width=device-width,initial-scale=1">'
               '<meta name="robots" content="noindex,nofollow">'
               f"<title>{titulo}</title>"
               "<style>:root{color-scheme:light}body{margin:0}</style>"
               "</head><body>" + cuerpo + "</body></html>")
    open(args.salida, "w", encoding="utf-8").write(tpl)
    print(f"OK -> {args.salida} ({len(tpl) // 1024} KB, cifrado con la clave entregada)")
    print(f"  MRR {es(kpi['mrr'])} k | +{es(kpi['yoy'])}% | NRR local {es(kpi['nrr_local'])}% | "
          f"fuga {es(kpi['churn_mrr_12m'])}% | activos {es0(kpi['activos'])} | riesgo {riesgo_total}")


if __name__ == "__main__":
    main()
