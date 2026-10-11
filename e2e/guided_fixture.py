"""Synthetic invoice exports for the guided import (e2e/guided_import.py) — generated, never stored.

Two exports of the same Jan–Jun 2026 invoice report, shaped like a real ERP extract (Portuguese
headers, AOA amounts written as text in Portuguese format, document numbers that repeat across
document types, a customer whose name is spelt two ways, a handful of cancelled documents):

  A  the first export: header on row 1.
  B  a corrected re-export with layout drift — two title lines above the header, "Valor Total"
     renamed "Valor Total (AOA)" and moved after "Status", "Ref. Cliente" dropped, a new mostly
     empty "Observações" — and logged edits: documents closed, amounts corrected, documents
     removed and added.

`build()` returns both workbooks as XLSX bytes plus the expected figures, computed here
independently of the server. The XLSX writer below is deliberately minimal (shared strings, one
date style) so the fixture exercises the same paths as an exported file without any dependency.
"""
import datetime as dt
import io
import random
import zipfile
from xml.sax.saxutils import escape

EPOCH = dt.date(1899, 12, 30)


def xlsx(rows, sheet="Folha1"):
    """rows: lists of str | int | float | datetime.date | None. Dates become real date cells."""
    sst, index = [], {}

    def shared(s):
        if s not in index:
            index[s] = len(sst)
            sst.append(s)
        return index[s]

    def col(i):
        s = ""
        i += 1
        while i:
            i, r = divmod(i - 1, 26)
            s = chr(65 + r) + s
        return s

    out = []
    for r, row in enumerate(rows, start=1):
        cells = []
        for c, v in enumerate(row):
            ref = f"{col(c)}{r}"
            if v is None or v == "":
                continue
            if isinstance(v, dt.date):
                cells.append(f'<c r="{ref}" s="1"><v>{(v - EPOCH).days}</v></c>')
            elif isinstance(v, (int, float)):
                cells.append(f'<c r="{ref}"><v>{v}</v></c>')
            else:
                cells.append(f'<c r="{ref}" t="s"><v>{shared(str(v))}</v></c>')
        out.append(f'<row r="{r}">{"".join(cells)}</row>')
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    rel = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook {ns} {rel}><sheets><sheet name="{escape(sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
        "xl/styles.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet {ns}><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>',
        "xl/sharedStrings.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst {ns} count="{len(sst)}" uniqueCount="{len(sst)}">' + "".join(f'<si><t xml:space="preserve">{escape(s)}</t></si>' for s in sst) + "</sst>",
        "xl/worksheets/sheet1.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet {ns}><sheetData>{"".join(out)}</sheetData></worksheet>',
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, text in files.items():
            z.writestr(name, text)
    return buf.getvalue()


def pt(amount):
    """45000.5 -> '45.000,50' (the export writes amounts as Portuguese-formatted text)."""
    whole, cents = f"{amount:,.2f}".split(".")
    return whole.replace(",", ".") + "," + cents


CUSTOMERS = [
    ("C1", "PARTICULARES", 30),
    ("C3", "ALFA-SEGUROS DE TESTE, S.A.", 9),
    ("C7", "COMPANHIA EXEMPLO DE SEGUROS, S.A.", 7),
    ("C12", "CLINICA MODELO - GESTAO DE SAUDE, LDA", 6),
    ("C15", "TRANSPORTES DEMONSTRACAO, LDA", 5),
    ("C18", "BETA SEGUROS DE TESTE, S.A.", 5),
    ("C21", "GAMA SEGUROS DE TESTE, S.A.", 4),
    ("C24", "DELTA SEGUROS DE TESTE, S.A.", 4),
] + [(f"C{30 + i}", f"CLIENTE EMPRESA {i + 1:02d}, LDA", 1) for i in range(16)]
VARIANT = ("C3", "ALFA, SEGUROS DE TESTE, S.A.")  # the same customer, spelt another way on some rows
N = 1800
CANCELLED = 6


def build(seed=2026):
    rnd = random.Random(seed)
    start = dt.date(2026, 1, 1)
    days = (dt.date(2026, 6, 30) - start).days + 1
    dates = sorted(start + dt.timedelta(days=rnd.randrange(days)) for _ in range(N))
    weights = [w for _, _, w in CUSTOMERS]
    seq = {"Fatura": 0, "Nota de Crédito": 0}
    docs = []
    for i, d in enumerate(dates):
        kind = "Nota de Crédito" if rnd.random() < 0.04 else "Fatura"
        seq[kind] += 1
        code, name, _ = rnd.choices(CUSTOMERS, weights)[0]
        if code == VARIANT[0] and rnd.random() < 0.3:
            name = VARIANT[1]
        amount = round(rnd.choice([rnd.randrange(10, 900) * 100, rnd.randrange(1000, 90000) * 10 + rnd.choice([0, 0.5, 0.25])]), 2)
        docs.append({
            "tipo": kind, "interno": 100001 + i, "numero": seq[kind], "agt": f"{'FT' if kind == 'Fatura' else 'NC'} {'FT' if kind == 'Fatura' else 'NC'}2026S1/{seq[kind]}",
            "codigo": code, "cliente": name, "data": d, "valor": amount,
            "status": "Fechada" if rnd.random() < 0.25 else "Aberta", "ref": f"R{rnd.randrange(1000, 9999)}" if rnd.random() < 0.2 else None,
        })
    for i in rnd.sample(range(N), CANCELLED):
        docs[i]["status"] = "Cancelada"
    # cells that a spreadsheet would run as formulas: they must stay inert text
    docs[10]["ref"] = '=HYPERLINK("http://evil.test","open")'
    docs[11]["ref"] = "@SUM(1+1)"

    # B: the corrected re-export
    eligible = [d for d in docs if d["tipo"] == "Fatura" and d["status"] == "Aberta"]
    picked = rnd.sample(eligible, 30 + 12 + 8)
    closed, corrected, removed = picked[:30], picked[30:42], picked[42:]
    deltas = {}
    for k, d in enumerate(corrected):
        deltas[d["interno"]] = round((k + 1) * 1000 + 250.5, 2) * (1 if k % 3 else -1)
    added = []
    for k in range(10):
        d = dt.date(2026, 6, 20 + k % 10)
        added.append({"tipo": "Fatura", "interno": 100001 + N + k, "numero": seq["Fatura"] + k + 1, "agt": f"FT FT2026S1/{seq['Fatura'] + k + 1}", "codigo": "C1", "cliente": "PARTICULARES", "data": d, "valor": 5000.0 + 100 * k, "status": "Aberta", "ref": None})
    gone = {d["interno"] for d in removed}
    shut = {d["interno"] for d in closed}
    b_docs = []
    for d in docs:
        if d["interno"] in gone:
            continue
        e = dict(d)
        if e["interno"] in shut:
            e["status"] = "Fechada"
        if e["interno"] in deltas:
            e["valor"] = round(e["valor"] + deltas[e["interno"]], 2)
        b_docs.append(e)
    b_docs += added

    head_a = ["Tipo Documento", "Nº interno", "Nº Documento", "Nº Documento AGT", "Código Cliente", "Cliente", "Ref. Cliente", "Data Emissão", "Data Vencimento", "Moeda", "Valor Total", "Status"]
    rows_a = [head_a] + [[d["tipo"], d["interno"], d["numero"], d["agt"], d["codigo"], d["cliente"], d["ref"], d["data"], d["data"], "AOA", pt(d["valor"]), d["status"]] for d in docs]
    head_b = ["Tipo Documento", "Nº interno", "Nº Documento", "Nº Documento AGT", "Código Cliente", "Cliente", "Data Emissão", "Data Vencimento", "Moeda", "Status", "Valor Total (AOA)", "Observações"]
    notes = {d["interno"]: "valor corrigido" for d in corrected}
    rows_b = [["Extrair Facturas — 2026 (corrigido)"], [None], head_b] + [[d["tipo"], d["interno"], d["numero"], d["agt"], d["codigo"], d["cliente"], d["data"], d["data"], "AOA", d["status"], pt(d["valor"]), notes.get(d["interno"])] for d in b_docs]

    def net(ds):
        return round(sum((-1 if d["tipo"] == "Nota de Crédito" else 1) * d["valor"] for d in ds if d["status"] != "Cancelada"), 2)

    kept_a = [d for d in docs if d["status"] != "Cancelada"]
    expected = {
        "a": {"rows": N, "kept": len(kept_a), "cancelled": CANCELLED, "credit_notes": sum(d["tipo"] == "Nota de Crédito" for d in docs), "net": net(docs), "gross": round(sum(d["valor"] for d in docs), 2),
              "repeated_numbers": sum(d["tipo"] == "Nota de Crédito" for d in docs), "variant": VARIANT, "variant_of": next(n for c, n, _ in CUSTOMERS if c == VARIANT[0]),
              "variant_docs": sum(d["codigo"] == VARIANT[0] and d["status"] != "Cancelada" for d in docs), "hostile": [docs[10]["ref"], docs[11]["ref"]], "months": sorted({d["data"].strftime("%Y-%m") for d in docs}),
              "by_month": {m: round(sum((-1 if d["tipo"] == "Nota de Crédito" else 1) * d["valor"] for d in kept_a if d["data"].strftime("%Y-%m") == m), 2) for m in sorted({d["data"].strftime("%Y-%m") for d in docs})}},
        "b": {"rows": len(b_docs), "header_row": 3, "net": net(b_docs)},
        "compare": {
            "status": len(closed), "status_from": "Aberta", "status_to": "Fechada",
            "amount": len(corrected), "amount_net": round(sum(deltas.values()), 2),
            "only_here": sorted(d["interno"] for d in added), "only_there": sorted(gone),
            "closed": sorted(shut), "corrected": {str(k): v for k, v in deltas.items()},
        },
    }
    return xlsx(rows_a), xlsx(rows_b), expected


if __name__ == "__main__":
    import json, sys
    a, b, exp = build()
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    open(f"{out}/facturas-h1.xlsx", "wb").write(a)
    open(f"{out}/facturas-h1-corrigido.xlsx", "wb").write(b)
    json.dump(exp, open(f"{out}/facturas-expected.json", "w"), indent=1, default=str, ensure_ascii=False)
    print(len(a), len(b), json.dumps({k: v for k, v in exp["a"].items() if k != "by_month"}, default=str, ensure_ascii=False))
