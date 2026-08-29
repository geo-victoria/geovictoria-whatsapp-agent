#!/usr/bin/env python3
"""
Monitoreo mensual del MRR de GeoVictoria.

Toma el export mensual "MRR_consolidado_YYYYMM.xlsx" (pestañas
'Facturación x Producto USD' y 'Facturación x Producto MonLocal'),
aplica las fusiones de conglomerados validadas (fusiones_conglomerados.csv)
y genera un Excel de monitoreo con:

  - Resumen ......... KPIs del mes (MRR, crecimiento, NRR local/USD, fuga)
  - En riesgo ....... cuentas grandes con contracción sostenida en moneda local
  - Fugas 12m ....... mayores conglomerados fugados en la última cohorte
  - NRR país ........ NRR por país en moneda local y USD

Uso:
    python monitoreo_mrr.py MRR_consolidado_202608.xlsx [salida.xlsx]

Requiere: pandas, numpy, openpyxl.

Convenciones (definidas con Finanzas):
  - NRR se reporta SIEMPRE en moneda local (t.c. constante); USD es referencia.
  - Fuga = conglomerado sin facturación en los últimos 3 meses del archivo.
  - Riesgo = cuenta activa ≥ US$500/mes cuya facturación en moneda local cayó
    ≥22% entre el promedio de los meses -8..-6 y el promedio de los últimos 3.
  - Si un país no tiene datos en el último mes (todos sus clientes en cero a la
    vez, p.ej. España jul-2026), se usa el mes anterior para ese país.
"""
import sys, re, os
import numpy as np
import pandas as pd

AQUI = os.path.dirname(os.path.abspath(__file__))
UMBRAL_RIESGO_USD = 500      # MRR mínimo para entrar a la lista de riesgo
CONTRACCION_RIESGO = 0.22    # 22% de caída en moneda local
SUFIJOS = {"S.A.","S.A","SA","SPA","S.P.A.","LTDA","LTDA.","SAC","S.A.C.","SAS",
           "S.A.S","S.A.S.","SRL","S.R.L.","EST","EIRL","E.I.R.L.","SAU","S.A.U.",
           "CIA","INC","CORP","LLC","SL","S.L.","CV","C.V."}
CONECTORES = {"de","del","la","las","los","y","e","en","al","a","el"}


def cargar_fusiones():
    f = pd.read_csv(os.path.join(AQUI, "fusiones_conglomerados.csv"))
    return dict(zip(f["etiqueta_original"].astype(str), f["grupo_corregido"]))


def corregir_conglomerado(row, fusiones):
    c = str(row["Conglomerado / RUT"]).strip()
    if c == "55555555":  # placeholder histórico: desarmar
        cli = str(row["Cliente"]).upper()
        if "THYSSENKRUPP" in cli or "TK ELEVADORES" in cli:
            return "TK Elevadores"
        if "SWISSPORT" in cli:
            return "30695605125"
        if "TREINTA Y TRES" in cli:
            return "G. Treinta y Tres (G33)"
        return str(row["Cliente"]).strip()
    return fusiones.get(c, c)


def es_codigo(s):
    s = str(s).strip()
    return " " not in s and sum(ch.isdigit() for ch in s) >= 4


def nombre_bonito(n):
    n = re.sub(r"\s+", " ", str(n).strip())
    out = []
    for i, w in enumerate(n.split(" ")):
        wu = w.upper().strip(",")
        if wu in SUFIJOS:
            out.append(wu)
        elif w.lower() in CONECTORES and i > 0:
            out.append(w.lower())
        else:
            out.append(w.capitalize())
    return " ".join(out)


def preparar(df, mcols, fusiones):
    df = df.copy()
    df["CG"] = df.apply(lambda r: corregir_conglomerado(r, fusiones), axis=1)
    # países sin carga en el último mes -> usar el anterior (a nivel de fila)
    ult, ant = mcols[-1], mcols[-2]
    por_pais = df.groupby(df["País"].astype(str).str.strip())[ult].sum()
    sin_carga = set(por_pais[por_pais <= 0].index) | {"ESPAÑA"} if False else set(por_pais[por_pais <= 0].index)
    # España-style: país con >20 clientes activos el mes anterior y <10% de ellos el último
    act_ant = df[df[ant] > 0].groupby(df["País"].astype(str).str.strip()).size()
    act_ult = df[df[ult] > 0].groupby(df["País"].astype(str).str.strip()).size()
    for p, n_ant in act_ant.items():
        if n_ant >= 20 and act_ult.get(p, 0) < 0.1 * n_ant:
            sin_carga.add(p)
    m = df["País"].astype(str).str.strip().isin(sin_carga) & (df[ult].isna() | (df[ult] == 0))
    df.loc[m, ult] = df.loc[m, ant]
    if sin_carga:
        print(f"  aviso: sin carga del último mes, usando mes anterior: {sorted(sin_carga)}")
    return df


def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    ruta = sys.argv[1]
    salida = sys.argv[2] if len(sys.argv) > 2 else "Monitoreo_MRR.xlsx"
    fusiones = cargar_fusiones()

    usd = pd.read_excel(ruta, sheet_name="Facturación x Producto USD")
    loc = pd.read_excel(ruta, sheet_name="Facturación x Producto MonLocal")
    mcols = [c for c in usd.columns if re.match(r"^[a-z]+-20\d\d$", str(c))]
    print(f"meses: {mcols[0]} .. {mcols[-1]} ({len(mcols)})")
    usd = preparar(usd, mcols, fusiones)
    loc = preparar(loc, mcols, fusiones)

    MU = usd.groupby("CG")[mcols].sum().clip(lower=0)
    usd["_t"] = usd[mcols].sum(axis=1)
    top = usd.sort_values("_t", ascending=False).drop_duplicates("CG").set_index("CG")
    pais, indust, cliente = top["País"].str.strip(), top["Industria"], top["Cliente"]
    nombre = {cg: (nombre_bonito(cliente[cg]) if es_codigo(cg) else cg) for cg in MU.index}
    ML = {p: g.groupby("CG")[mcols].sum().clip(lower=0)
          for p, g in loc.groupby(loc["País"].astype(str).str.strip())}
    MUC = {p: g.groupby("CG")[mcols].sum().clip(lower=0)
           for p, g in usd.groupby(usd["País"].astype(str).str.strip())}

    ult = mcols[-1]
    m0, m1 = mcols[-13], mcols[-1]          # cohorte NRR 12 meses
    rec3, prev3 = mcols[-3:], mcols[-9:-6]  # ventanas de riesgo

    # ---- NRR por país (local primero) ----
    filas = []
    for p in sorted(MUC, key=lambda x: -MUC[x][m0].sum()):
        Uc, Lc = MUC[p], ML.get(p)
        cu = Uc[Uc[m0] > 0]
        if len(cu) == 0 or Lc is None:
            continue
        cl = Lc[Lc[m0] > 0]
        filas.append({"país": p.title(),
                      "base_usd_k": round(cu[m0].sum() / 1000, 1),
                      "nrr_moneda_local_%": round(cl[m1].sum() / cl[m0].sum() * 100, 1),
                      "nrr_usd_%": round(cu[m1].sum() / cu[m0].sum() * 100, 1)})
    nrr_pais = pd.DataFrame(filas)
    num = sum(r["nrr_moneda_local_%"] * r["base_usd_k"] for r in filas)
    den = sum(r["base_usd_k"] for r in filas)
    nrr_local_total = round(num / den, 1)

    # ---- fuga cohorte 12m ----
    coh = MU[MU[m0] > 0]
    fuga = coh[(coh[rec3] <= 0).all(axis=1)]
    fugas12 = pd.DataFrame({
        "conglomerado": [nombre[i] for i in fuga.index],
        "país": [pais.get(i, "") for i in fuga.index],
        "industria": [str(indust.get(i, "")) for i in fuga.index],
        "mrr_perdido_usd": fuga[m0].round(0)}).sort_values("mrr_perdido_usd", ascending=False)

    # ---- cuentas en riesgo (contracción en moneda local) ----
    filas = []
    for cg in MU[(MU[ult] > 0) & (MU[rec3].mean(axis=1) >= UMBRAL_RIESGO_USD)].index:
        p = pais.get(cg, "")
        Lc = ML.get(p)
        if Lc is None or cg not in Lc.index:
            continue
        a, b = Lc.loc[cg, rec3].mean(), Lc.loc[cg, prev3].mean()
        if b > 0 and a / b <= 1 - CONTRACCION_RIESGO:
            filas.append({"conglomerado": nombre[cg], "país": p,
                          "industria": str(indust.get(cg, "")),
                          "mrr_usd_actual": round(MU.loc[cg, rec3].mean(), 0),
                          "contracción_local_%": round((1 - a / b) * 100, 1)})
    riesgo = pd.DataFrame(filas).sort_values("mrr_usd_actual", ascending=False)

    # ---- resumen ----
    nrr_usd_total = round(coh[m1].sum() / coh[m0].sum() * 100, 1)
    resumen = pd.DataFrame([
        ("Mes de cierre", ult),
        ("MRR total (kUSD)", round(MU[ult].sum() / 1000, 1)),
        ("Crecimiento 12m (%)", round((MU[ult].sum() / MU[m0].sum() - 1) * 100, 1)),
        ("Conglomerados activos", int((MU[ult] > 0).sum())),
        ("NRR 12m moneda local (%)", nrr_local_total),
        ("NRR 12m USD, referencia (%)", nrr_usd_total),
        ("Fuga 12m: conglomerados", len(fugas12)),
        ("Fuga 12m: MRR (kUSD)", round(fugas12["mrr_perdido_usd"].sum() / 1000, 1)),
        ("Fuga 12m: % de la base", round(fugas12["mrr_perdido_usd"].sum() / coh[m0].sum() * 100, 1)),
        ("Cuentas grandes en riesgo", len(riesgo)),
        ("MRR en riesgo (kUSD/mes)", round(riesgo["mrr_usd_actual"].sum() / 1000, 1) if len(riesgo) else 0),
    ], columns=["indicador", "valor"])

    with pd.ExcelWriter(salida, engine="openpyxl") as w:
        resumen.to_excel(w, sheet_name="Resumen", index=False)
        riesgo.to_excel(w, sheet_name="En riesgo", index=False)
        fugas12.head(100).to_excel(w, sheet_name="Fugas 12m", index=False)
        nrr_pais.to_excel(w, sheet_name="NRR país", index=False)
    print(f"OK -> {salida}")
    print(resumen.to_string(index=False))


if __name__ == "__main__":
    main()
